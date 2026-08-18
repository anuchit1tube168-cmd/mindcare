/**
 * ==========================================================
 * ระบบดูแลใจ วพอ.พอ. — Backend (Google Apps Script)
 * รับผลประเมิน ST-5 / 2Q / 9Q / 8Q จากหน้า LIFF/เว็บ
 * เก็บลง Google Sheets + แจ้งเตือนอาจารย์ผ่าน LINE Messaging API
 *
 * หมายเหตุสำคัญ:
 * - LINE Notify ปิดบริการแล้ว (มี.ค. 2568) จึงใช้ Messaging API push
 * - เก็บ LINE_CHANNEL_ACCESS_TOKEN ใน Script Properties เท่านั้น
 *   (Project Settings → Script Properties) ห้ามใส่ในโค้ดหรือชีต
 * - Deploy เป็น Web App: Execute as Me / Access: Anyone
 *
 * วิธีเริ่มใช้: รัน setup() หนึ่งครั้งเพื่อสร้างชีตทั้งหมด
 * ==========================================================
 */

const SHEETS = {
  ASSESSMENTS: "Assessments",   // ผลประเมินทุกครั้ง
  ALERTS: "Alerts",             // งานที่อาจารย์ต้องติดตาม พร้อมสถานะ
  TEACHERS: "Teachers",         // รายชื่ออาจารย์ผู้ดูแล + LINE userId
  BINDINGS: "Bindings",         // ผูก LINE userId ↔ รหัสนักเรียน
  ROSTER: "Roster",             // ทะเบียนรหัสนักเรียนสำหรับตรวจสอบตอนผูกบัญชี
  REPORTS: "Reports",           // รายงานเฝ้าระวังรายสัปดาห์ (เก็บประวัติ)
  RPT_YEAR: "รายงานรายชั้นปี",     // สรุปแยกชั้นปี (สร้างจากเมนูในชีต)
  RPT_PERSON: "รายงานรายบุคคล",    // สรุปรายคน ครั้งล่าสุด/สูงสุด
  RPT_RISK: "รายงานกลุ่มเสี่ยง",   // เฉพาะเคสที่ต้องดูแล เรียงตามความรุนแรง
  ERRORS: "ErrorLog",           // บันทึกข้อผิดพลาดของระบบ
};

// SLA การติดต่อกลับตามระดับความเสี่ยง (ชั่วโมง) ตามแนวทาง ทอ. (ผนวก ค)
// RED = พบแพทย์ทันที (1 ชม.), ORANGE = พบแพทย์ภายใน 3 วัน (72 ชม.), YELLOW = พบแพทย์ภายใน 1 สัปดาห์ (168 ชม.)
const SLA_HOURS = { RED: 1, ORANGE: 72, YELLOW: 168 };

// โฟลเดอร์ Google Drive ปลายทางสำหรับเก็บไฟล์รายงาน (Excel/CSV)
// ต้องเป็นโฟลเดอร์ที่บัญชีเจ้าของสคริปต์มีสิทธิ์เขียน
const DRIVE_FOLDER_ID = "1cecXhoC2-JaKvEAQv-W3ohEmIOjFw-gt";

/* ==========================================================
 * Web App entry points
 * ========================================================== */

function doPost(e) {
  // ใช้ Lock กันเขียนชนกันเมื่อนักเรียนหลายคนส่งพร้อมกัน
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const data = JSON.parse(e.postData.contents);

    if (data.action === "submitAssessment") {
      return output(handleSubmit(data));
    }
    if (data.action === "resolveStudent") {
      return output(handleResolveStudent(data));
    }
    if (data.action === "bindStudent") {
      return output(handleBindStudent(data));
    }
    if (data.action === "verifyStudent") {
      return output(handleVerifyStudent(data));
    }
    // ---- ส่วนของอาจารย์: ต้องมี token เพราะเป็นข้อมูลอ่อนไหวรายบุคคล ----
    if (data.action === "getDashboard") {
      requireToken(data);
      return output({ ok: true, ...getDashboardData() });
    }
    if (data.action === "updateAlertStatus") {
      requireToken(data);
      return output(handleUpdateAlertStatus(data));
    }
    if (data.action === "getSummary") {
      return output(getSummary());
    }

    return output({ ok: false, error: "unknown action" });
  } catch (err) {
    logError("doPost", err, e ? e.postData.contents : "");
    return output({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return output({ ok: true, status: "RTAFNC MindCare API is running" });
}

/* ==========================================================
 * ส่วนประเมินความเสี่ยง และบันทึกผล
 * ========================================================== */

function handleSubmit(d) {
  // validate ขั้นต่ำ — ป้องกันข้อมูลผิดรูปแบบพังทั้งแถว
  if (!d.studentId) throw new Error("missing studentId");
  if (typeof d.st5Score !== "number") throw new Error("missing st5Score");

  const risk = evaluateRisk(d);
  const assessmentId = "A" + Date.now() + Math.floor(Math.random() * 1000);

  appendAssessment(assessmentId, d, risk);

  // สร้างงานติดตาม + แจ้งเตือน เฉพาะระดับที่ต้องมีคนตามจริง
  let alertId = null;
  if (risk.level !== "GREEN") {
    alertId = createAlert(assessmentId, d, risk);
    // แจ้ง LINE/Telegram เฉพาะ ORANGE/RED (หรือเคสมีธงเสี่ยง)
    if (risk.level === "RED" || risk.level === "ORANGE") {
      notifyTeachers(alertId, d, risk);
    }
  }

  return { ok: true, assessmentId: assessmentId, riskLevel: risk.level, alertId: alertId };
}

/**
 * ประเมินระดับความเสี่ยงรวมจากทุกชุด
 * RED    = 8Q ≥ 17 (เกณฑ์ทางการ: ส่งต่อ รพ.ที่มีจิตแพทย์ด่วน)
 * ORANGE = 8Q 9–16 หรือ 9Q ≥ 13 (ควรพบบุคลากรทางการแพทย์)
 * YELLOW = 8Q 1–8 หรือ 9Q 7–12 หรือ ST-5 ≥ 10 หรือธงสัญญาณขัดแย้ง
 * GREEN  = นอกเหนือจากนั้น
 */
function evaluateRisk(d) {
  const q8 = numOrNull(d.q8Score);
  const q9 = numOrNull(d.q9Score);
  const st5 = numOrNull(d.st5Score);
  const conflict = d.conflictFlag === true;

  if (q8 !== null && q8 >= 17) {
    return { level: "RED", reason: "8Q = " + q8 + " (ระดับรุนแรง)" };
  }
  if ((q8 !== null && q8 >= 9) || (q9 !== null && q9 >= 13)) {
    return { level: "ORANGE", reason: "8Q = " + q8 + " / 9Q = " + q9 };
  }
  if ((q8 !== null && q8 >= 1) || (q9 !== null && q9 >= 7) || (st5 !== null && st5 >= 10) || conflict) {
    return {
      level: "YELLOW",
      reason: conflict ? "สัญญาณขัดแย้ง (ตอบปกติแต่ดัชนีพฤติกรรมสูง)" : "8Q = " + q8 + " / 9Q = " + q9 + " / ST-5 = " + st5,
    };
  }
  return { level: "GREEN", reason: "อยู่ในเกณฑ์ปกติ" };
}

/**
 * ผูก/ค้นหารหัสนักเรียนจาก LINE userId
 * ชีต Bindings: lineUserId | studentId | boundAt
 * ระบบจริง: การผูกครั้งแรกควรผ่านการยืนยันตัวตน (เช่น อาจารย์อนุมัติ
 * หรือกรอกรหัส+เลขบัตรตรงกับทะเบียน) — ที่นี่คืนเฉพาะที่ผูกไว้แล้ว
 */
function handleResolveStudent(d) {
  if (!d.lineUserId) throw new Error("missing lineUserId");
  const sh = getSheet(SHEETS.BINDINGS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(d.lineUserId)) {
      return { ok: true, studentId: rows[i][1] };
    }
  }
  return { ok: true, studentId: null, needBinding: true };
}

/**
 * ตรวจรหัสประจำตัวกับทะเบียน Roster แล้วคืนชื่อให้นักเรียนยืนยันตัวตน
 * ใช้กับหน้าเข้าระบบแบบ "กรอกรหัส ไม่ต้องล็อกอิน"
 *
 * คืนเฉพาะ "ชื่อย่อ" (ชื่อต้น + อักษรแรกของนามสกุล) โดยเจตนา
 * เพราะ endpoint นี้เปิดสาธารณะและรหัสนักเรียนเรียงติดกัน
 * ถ้าคืนชื่อเต็ม จะไล่ยิงรหัสดึงทะเบียนทั้งชุดได้
 */
function handleVerifyStudent(d) {
  const studentId = String(d.studentId || "").trim();
  if (!/^\d{7}$/.test(studentId)) {
    return { ok: false, error: "รหัสประจำตัวต้องเป็นตัวเลข 7 หลัก" };
  }
  const roster = getSheet(SHEETS.ROSTER).getDataRange().getValues();
  for (let i = 1; i < roster.length; i++) {
    if (String(roster[i][0]).trim() === studentId) {
      return {
        ok: true,
        studentId: studentId,
        nameMasked: maskName(String(roster[i][1] || "")),
        year: roster[i][2] || "",
      };
    }
  }
  return { ok: false, error: "ไม่พบรหัสนี้ในทะเบียน กรุณาตรวจสอบหรือติดต่ออาจารย์" };
}

/** ย่อชื่อสำหรับยืนยันตัวตน: "นพอ. กนกนุช อาจคำไพร" → "นพอ. กนกนุช อ." */
function maskName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length < 2) return full;
  const last = parts.pop();
  return parts.join(" ") + " " + last.charAt(0) + ".";
}

/**
 * ผูก LINE userId กับรหัสนักเรียน (เรียกจากหน้า LIFF ตอนลงทะเบียนครั้งแรก)
 * ตรวจสอบ: รหัสต้องมีอยู่จริงในชีต Roster และยังไม่ถูกผูกกับ LINE อื่น
 * กันการสวมรอย/ผูกซ้ำ — ระบบจริงอาจเพิ่มการยืนยันตัวตนที่เข้มขึ้น
 */
function handleBindStudent(d) {
  if (!d.lineUserId) throw new Error("missing lineUserId");
  const studentId = String(d.studentId || "").trim();
  if (!/^\d{7}$/.test(studentId)) {
    return { ok: false, error: "รหัสประจำตัวต้องเป็นตัวเลข 7 หลัก" };
  }

  // ตรวจว่ารหัสมีอยู่จริงในทะเบียน (Roster)
  const roster = getSheet(SHEETS.ROSTER).getDataRange().getValues();
  let found = null;
  for (let i = 1; i < roster.length; i++) {
    if (String(roster[i][0]).trim() === studentId) {
      found = { studentId: studentId, name: roster[i][1], year: roster[i][2] };
      break;
    }
  }
  if (!found) {
    return { ok: false, error: "ไม่พบรหัสนี้ในทะเบียนนักเรียน กรุณาตรวจสอบหรือติดต่ออาจารย์" };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getSheet(SHEETS.BINDINGS);
    const rows = sh.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      // รหัสนี้ถูกผูกกับ LINE อื่นไปแล้ว
      if (String(rows[i][1]).trim() === studentId && String(rows[i][0]) !== String(d.lineUserId)) {
        return { ok: false, error: "รหัสนี้ถูกผูกกับบัญชี LINE อื่นแล้ว หากเป็นความผิดพลาดโปรดติดต่ออาจารย์" };
      }
      // LINE นี้เคยผูกไว้แล้ว → อัปเดตเป็นรหัสใหม่
      if (String(rows[i][0]) === String(d.lineUserId)) {
        sh.getRange(i + 1, 2).setValue(studentId);
        sh.getRange(i + 1, 3).setValue(new Date());
        return { ok: true, studentId: studentId, name: found.name, updated: true };
      }
    }
    // ผูกใหม่
    sh.appendRow([d.lineUserId, studentId, new Date()]);
    return { ok: true, studentId: studentId, name: found.name };
  } finally {
    lock.releaseLock();
  }
}

function appendAssessment(assessmentId, d, risk) {
  const sh = getSheet(SHEETS.ASSESSMENTS);
  sh.appendRow([
    new Date(),
    assessmentId,
    sanitize(d.studentId),
    sanitize(d.lineUserId || ""),   // ผูกผลกับ LINE userId เพื่อ push แจ้งเตือนรายคนได้
    numOrNull(d.st5Score),
    numOrNull(d.q2Score),
    numOrNull(d.q9Score),
    numOrNull(d.q9Item9),
    numOrNull(d.q8Score),
    numOrNull(d.behaviorIndex),
    d.behaviorFlags ? sanitize(JSON.stringify(d.behaviorFlags)) : "",
    d.conflictFlag === true,
    d.cameraUsed === true,
    risk.level,
    sanitize(risk.reason),
    d.behaviorDetail ? sanitize(JSON.stringify(d.behaviorDetail)) : "",
    sanitize(d.displayName || ""),                    // ชื่อที่แสดง (จากทะเบียน หรือกรอกเอง)
    sanitize(d.userType || "student"),                // student / staff / guest
  ]);
}

/* ==========================================================
 * ระบบงานติดตาม (Alerts) + แจ้งเตือนอาจารย์
 * ========================================================== */

function createAlert(assessmentId, d, risk) {
  const alertId = "AL" + Date.now() + Math.floor(Math.random() * 1000);
  const due = new Date(Date.now() + SLA_HOURS[risk.level] * 3600 * 1000);
  getSheet(SHEETS.ALERTS).appendRow([
    new Date(),
    alertId,
    assessmentId,
    sanitize(d.studentId),
    risk.level,
    sanitize(risk.reason),
    "แจ้งแล้ว",     // สถานะ: แจ้งแล้ว → รับเรื่องแล้ว → ติดต่อแล้ว → ปิดเคส
    due,            // กำหนดติดต่อภายใน (ตาม SLA)
    "",             // ผู้รับผิดชอบ
    "",             // เวลาที่ติดต่อจริง
    "",             // บันทึกการดูแล
    0,              // จำนวนครั้งที่ escalate
  ]);
  return alertId;
}

function notifyTeachers(alertId, d, risk) {
  const icon = risk.level === "RED" ? "🚨🔴" : (risk.level === "ORANGE" ? "⚠️🟠" : "🟡");
  const slaText = risk.level === "RED" ? "ติดต่อด่วนที่สุด ภายใน 1 ชม." : (risk.level === "ORANGE" ? "ติดต่อภายใน 24 ชม." : "เฝ้าระวัง/ติดตาม");
  const nameStr = d.displayName ? d.displayName : ("รหัส " + d.studentId);
  const behVal = (d.behaviorIndex !== null && d.behaviorIndex !== undefined) ? (d.behaviorIndex + "/100") : "ไม่ได้เปิดกล้อง";

  const text =
    icon + " [แจ้งเตือนระบบดูแลใจ วพอ.พอ.]\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "👤 นักเรียน/ผู้ตรวจ: " + nameStr + " (ID: " + d.studentId + ")\n" +
    "📊 ระดับความเสี่ยง: " + risk.level + " (" + (risk.reason || "-") + ")\n" +
    "⏱️ SLA ติดตาม: " + slaText + "\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "📋 ผลคะแนนประเมิน:\n" +
    " • ST-5: " + (d.st5Score !== null ? d.st5Score : "-") + "/15\n" +
    " • 2Q: " + (d.q2Score !== null ? d.q2Score : "-") + "/2 | 9Q: " + (d.q9Score !== null ? d.q9Score : "-") + "/27\n" +
    " • 8Q: " + (d.q8Score !== null ? d.q8Score : "-") + "\n" +
    " • 📷 ดัชนีกล้อง AI: " + behVal + "\n" +
    (d.conflictFlag ? "⚠️ สัญญาณขัดแย้ง: ตอบปกติแต่พฤติกรรมกล้องบ่งชี้ความตึงเครียด\n" : "") +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🆔 รหัสงาน (Alert ID): " + alertId + "\n" +
    "📁 บันทึกข้อมูลลง Excel/Google Sheet เรียบร้อยแล้ว\n" +
    "👉 โปรดเปิด Dashboard เพื่อรับเรื่องและประสานการดูแล";

  const res = sendAlert(text, risk.level);

  // ส่งแจ้งเตือนกลับไปยัง LINE ของผู้ประเมินโดยตรง (ถ้าทำผ่าน LINE LIFF)
  if (d.lineUserId) {
    const props = PropertiesService.getScriptProperties();
    const lineToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
    if (lineToken) {
      const userFeedback =
        "💚 [ระบบดูแลใจ วพอ.พอ.]\n" +
        "บันทึกผลการประเมินของคุณเรียบร้อยแล้ว\n" +
        "ระดับการดูแล: " + risk.level + "\n" +
        (risk.level === "RED" || risk.level === "ORANGE"
          ? "มีอาจารย์ผู้ดูแลรับเรื่องแล้ว และพร้อมรับฟังเสมอเมื่อคุณต้องการ 🤝"
          : "ขอบคุณที่แวะมาเช็คสุขภาพใจ ขอให้เป็นวันที่ดีนะ 🌿");
      pushLineMessage(lineToken, d.lineUserId, userFeedback);
    }
  }

  // ถ้ามีภาพถ่ายใบหน้าขณะประเมิน (กรณีเฝ้าระวัง) -> ส่งภาพเข้า Telegram ทันทีแบบ Real-Time
  if (d.faceSnapshot && String(d.faceSnapshot).indexOf("data:image") === 0) {
    try {
      const base64Data = String(d.faceSnapshot).split(",")[1];
      const bytes = Utilities.base64Decode(base64Data);
      const photoBlob = Utilities.newBlob(bytes, "image/jpeg", "snapshot_" + d.studentId + ".jpg");
      const caption = "📸 [ภาพถ่ายขณะประเมิน - ระบบดูแลใจ]\n" +
        "👤 " + nameStr + " (ID: " + d.studentId + ")\n" +
        "📊 ระดับ: " + risk.level + " | 📷 ดัชนีกล้อง: " + behVal + "\n" +
        (d.conflictFlag ? "⚠️ สัญญาณขัดแย้งคำตอบ-พฤติกรรม\n" : "") +
        "🆔 " + alertId;
      pushTelegramPhoto(photoBlob, caption);
    } catch (err) {
      logError("notifyTeachers.photo", err, alertId);
    }
  }

  // ไม่ถึงมืออาจารย์เลยทั้งสองช่องทาง = เรื่องร้ายแรง ต้องมีร่องรอยไว้ตรวจ
  if (!res.telegram && res.line === 0) {
    logError("notifyTeachers", "ส่งแจ้งเตือนไม่สำเร็จทั้ง LINE และ Telegram", alertId);
  }
}

function pushLineMessage(token, userId, text) {
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ to: userId, messages: [{ type: "text", text: text }] }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      logError("pushLineMessage", "HTTP " + res.getResponseCode() + " " + res.getContentText(), userId);
      return false;
    }
    return true;
  } catch (err) {
    logError("pushLineMessage", err, userId);
    return false;
  }
}

/**
 * ส่งข้อความแจ้งเตือนเข้า Telegram group/chat
 */
function pushTelegramMessage(text) {
  const props = PropertiesService.getScriptProperties();
  const botToken = props.getProperty("TELEGRAM_BOT_TOKEN");
  const chatId = props.getProperty("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return false; // ยังไม่ตั้งค่า = ข้าม

  try {
    const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      logError("pushTelegramMessage", "HTTP " + res.getResponseCode() + " " + res.getContentText(), chatId);
      return false;
    }
    return true;
  } catch (err) {
    logError("pushTelegramMessage", err, "");
    return false;
  }
}

/**
 * ส่งภาพถ่ายใบหน้าเข้า Telegram group/chat (กรณีเฝ้าระวัง Real-Time)
 */
function pushTelegramPhoto(photoBlob, caption) {
  const props = PropertiesService.getScriptProperties();
  const botToken = props.getProperty("TELEGRAM_BOT_TOKEN");
  const chatId = props.getProperty("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId || !photoBlob) return false;

  try {
    const payload = {
      chat_id: chatId,
      photo: photoBlob,
      caption: caption || "",
    };
    const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + botToken + "/sendPhoto", {
      method: "post",
      payload: payload,
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      logError("pushTelegramPhoto", "HTTP " + res.getResponseCode() + " " + res.getContentText(), chatId);
      return false;
    }
    return true;
  } catch (err) {
    logError("pushTelegramPhoto", err, "");
    return false;
  }
}

/**
 * ตรวจ token ของฝั่งอาจารย์ — ตั้งค่า DASHBOARD_TOKEN ใน Script Properties
 * เหตุผล: Web App เปิด Access: Anyone เพื่อให้นักเรียนส่งผลได้
 * แต่ข้อมูลรายบุคคล (รหัสนักเรียน + ระดับเสี่ยง) ต้องไม่เปิดให้ใครก็ได้ดึงไป
 */
function requireToken(d) {
  const expected = PropertiesService.getScriptProperties().getProperty("DASHBOARD_TOKEN");
  if (!expected) throw new Error("ยังไม่ได้ตั้งค่า DASHBOARD_TOKEN ใน Script Properties");
  if (String(d.token || "") !== expected) throw new Error("token ไม่ถูกต้อง");
}

/**
 * ข้อมูลสำหรับ dashboard อาจารย์
 * - alerts: งานที่ยังไม่ปิดเคสทั้งหมด
 * - assessments: ผลประเมิน 50 รายการล่าสุด รวมดัชนีพฤติกรรมจากกล้อง
 *   (ส่งเฉพาะค่า index รวม ไม่ส่ง behaviorDetail รายตัวชี้วัด —
 *   ตามข้อกำหนดที่ล็อกไว้: อาจารย์เห็น "ดัชนีควรชวนคุย" ไม่ใช่กราฟอารมณ์)
 */
function getDashboardData() {
  const alertRows = getSheet(SHEETS.ALERTS).getDataRange().getValues();
  const alerts = [];
  for (let i = 1; i < alertRows.length; i++) {
    const r = alertRows[i];
    if (r[6] === "ปิดเคส") continue;
    alerts.push({
      createdAt: r[0], alertId: r[1], assessmentId: r[2], studentId: r[3],
      riskLevel: r[4], reason: r[5], status: r[6], dueAt: r[7],
      assignedTo: r[8], escalations: r[11],
    });
  }

  const aRows = getSheet(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const assessments = [];
  const start = Math.max(1, aRows.length - 50);
  for (let i = aRows.length - 1; i >= start; i--) {
    const r = aRows[i];
    // schema: timestamp,assessmentId,studentId,lineUserId,st5,q2,q9,q9Item9,q8,
    //         behaviorIndex,behaviorFlags,conflictFlag,cameraUsed,riskLevel,...
    assessments.push({
      timestamp: r[0], assessmentId: r[1], studentId: r[2],
      st5: r[4], q2: r[5], q9: r[6], q9Item9: r[7], q8: r[8],
      behaviorIndex: r[9], behaviorFlags: r[10],
      conflictFlag: r[11] === true, cameraUsed: r[12] === true,
      riskLevel: r[13],
    });
  }

  return { ok: true, alerts: alerts, assessments: assessments, updatedAt: new Date().toISOString() };
}

/**
 * อาจารย์อัปเดตสถานะงานจาก dashboard
 * สถานะที่ยอมรับ: รับเรื่องแล้ว → ติดต่อแล้ว → ปิดเคส
 */
function handleUpdateAlert(d) {
  if (!d.alertId) throw new Error("missing alertId");
  const allowed = ["รับเรื่องแล้ว", "ติดต่อแล้ว", "ปิดเคส"];
  if (allowed.indexOf(d.status) === -1) throw new Error("invalid status");

  const sh = getSheet(SHEETS.ALERTS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1] === d.alertId) {
      const row = i + 1;
      sh.getRange(row, 7).setValue(d.status);
      if (d.teacherName) sh.getRange(row, 9).setValue(sanitize(d.teacherName));
      if (d.status === "ติดต่อแล้ว" || d.status === "ปิดเคส") {
        if (!rows[i][9]) sh.getRange(row, 10).setValue(new Date());
      }
      if (d.careNote) {
        // ต่อท้ายบันทึกเดิม ไม่ทับ — ประวัติการดูแลต้องตามย้อนได้ (audit trail)
        const old = String(rows[i][10] || "");
        const stamp = Utilities.formatDate(new Date(), "Asia/Bangkok", "dd/MM HH:mm");
        sh.getRange(row, 11).setValue(sanitize(old + (old ? "\n" : "") + "[" + stamp + "] " + d.careNote));
      }
      return { ok: true };
    }
  }
  return { ok: false, error: "alert not found" };
}

/**
 * ส่งข้อความแจ้งอาจารย์ทุกคนใน Teachers sheet ที่มี lineUserId
 * ใช้ LINE Messaging API push (แทน LINE Notify ที่ปิดบริการแล้ว)
 */
function notifyTeachers(alertId, d, risk) {
  const token = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) {
    logError("notifyTeachers", "LINE_CHANNEL_ACCESS_TOKEN ยังไม่ได้ตั้งค่าใน Script Properties", alertId);
    return;
  }

  const recipients = getTeacherLineIds();
  if (recipients.length === 0) {
    logError("notifyTeachers", "ไม่มี lineUserId ในชีต Teachers", alertId);
    return;
  }

  const header = risk.level === "RED"
    ? "🔴 [ด่วนที่สุด] ต้องติดต่อภายใน 1 ชั่วโมง"
    : "🟠 [สำคัญ] ต้องติดต่อภายใน 24 ชั่วโมง";

  // เจตนาไม่ใส่คะแนนละเอียดในข้อความ LINE — กันข้อมูลอ่อนไหวหลุด
  // ถ้าเครื่องอาจารย์ถูกเปิดดูโดยคนอื่น ให้ดูรายละเอียดใน dashboard แทน
  const text =
    header + "\n" +
    "ระบบดูแลใจ วพอ.พอ.\n" +
    "รหัสนักเรียน: " + d.studentId + "\n" +
    "ระดับ: " + risk.level + "\n" +
    "รหัสงาน: " + alertId + "\n" +
    "โปรดเปิด dashboard เพื่อดูรายละเอียดและกดรับเรื่อง";

  recipients.forEach(function (userId) {
    pushLineMessage(token, userId, text);
  });

  // แจ้งเตือนเข้า Telegram ด้วย (ถ้าตั้งค่าไว้)
  pushTelegramMessage(text);
}

function pushLineMessage(token, userId, text) {
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ to: userId, messages: [{ type: "text", text: text }] }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      logError("pushLineMessage", "HTTP " + res.getResponseCode() + " " + res.getContentText(), userId);
    }
  } catch (err) {
    logError("pushLineMessage", err, userId);
  }
}

/**
 * ส่งข้อความแจ้งเตือนเข้า Telegram group/chat
 * ตั้งค่าใน Script Properties: TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID
 * - BOT_TOKEN: ได้จาก @BotFather ตอนสร้างบอท
 * - CHAT_ID: id ของกลุ่ม/แชทที่จะส่ง (กลุ่มขึ้นต้นด้วย -100...)
 * ถ้ายังไม่ตั้งค่า จะข้ามเงียบ ๆ ไม่ทำให้ระบบหลัก error
 */
function pushTelegramMessage(text) {
  const props = PropertiesService.getScriptProperties();
  const botToken = props.getProperty("TELEGRAM_BOT_TOKEN");
  const chatId = props.getProperty("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return; // ยังไม่ตั้งค่า = ข้าม

  try {
    const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      logError("pushTelegramMessage", "HTTP " + res.getResponseCode() + " " + res.getContentText(), chatId);
    }
  } catch (err) {
    logError("pushTelegramMessage", err, "");
  }
}

function getTeacherLineIds() {
  const sh = getSheet(SHEETS.TEACHERS);
  const rows = sh.getDataRange().getValues(); // อ่านครั้งเดียวทั้งตาราง (batch)
  const ids = [];
  for (let i = 1; i < rows.length; i++) {
    const lineUserId = String(rows[i][2] || "").trim();
    const active = rows[i][3] === true || String(rows[i][3]).toUpperCase() === "TRUE";
    if (lineUserId && active) ids.push(lineUserId);
  }
  return ids;
}
