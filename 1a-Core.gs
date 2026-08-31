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
  RPT_MISSING: "รายชื่อยังไม่ทำ",  // บัญชีรายชื่อ นพอ. ที่ยังไม่ทำแบบประเมิน แยกชั้นปี
  ERRORS: "ErrorLog",           // บันทึกข้อผิดพลาดของระบบ
};

// SLA การติดต่อกลับตามระดับความเสี่ยง (ชั่วโมง) ตามแนวทาง ทอ. (ผนวก ค)
// RED = พบแพทย์ทันที (1 ชม.), ORANGE = พบแพทย์ภายใน 3 วัน (72 ชม.), YELLOW = พบแพทย์ภายใน 1 สัปดาห์ (168 ชม.)
const SLA_HOURS = { RED: 1, ORANGE: 72, YELLOW: 168 };

// โฟลเดอร์ Google Drive ปลายทางสำหรับเก็บไฟล์รายงาน (Excel/CSV)
// ต้องเป็นโฟลเดอร์ที่บัญชีเจ้าของสคริปต์มีสิทธิ์เขียน
const DRIVE_FOLDER_ID = "1cecXhoC2-JaKvEAQv-W3ohEmIOjFw-gt";

// LINE Channel Access Token สำหรับส่ง LINE Flex Card สรุปผลให้นักเรียน
const DEFAULT_LINE_CHANNEL_ACCESS_TOKEN = "vyXhnvU/stGL9mUrIPKB+30x6OwFuFsercCL0UwISHKcV+qn3VW7FYL1kTa8kgm/+GpjDU3s+F/DPaFJwyZK58Y7iNrNXidTBmbaJu7w5ReFAiBmFe+QJ6z6tytonZPqmtfuO9pSU8tnmfRTh2+uvwdB04t89/1O/w1cDnyilFU=";

function getLineToken() {
  const propToken = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  return propToken || DEFAULT_LINE_CHANNEL_ACCESS_TOKEN;
}

/* ==========================================================
 * Web App entry points
 * ========================================================== */

function doPost(e) {
  // ใช้ Lock กันเขียนชนกันเมื่อนักเรียนหลายคนส่งพร้อมกัน
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const postBody = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const data = JSON.parse(postBody);

    // 0. ตั้งค่า LINE Token ผ่าน POST
    if (data.action === "setToken" && data.token) {
      PropertiesService.getScriptProperties().setProperty("LINE_CHANNEL_ACCESS_TOKEN", String(data.token).trim());
      return output({ ok: true, message: "บันทึก LINE_CHANNEL_ACCESS_TOKEN เรียบร้อยแล้ว" });
    }

    // ---- 1. รับข้อความและคำสั่งจาก Telegram Webhook (พิมพ์คำสั่งในกลุ่มแล้วบอทตอบทันที) ----
    if (data.message || data.callback_query || data.update_id) {
      handleTelegramWebhook(data);
      return output({ ok: true });
    }

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

/**
 * จัดการคำสั่งและข้อความที่พิมพ์ใน Telegram (@AI5STSMARTbot)
 * รองรับ: /missing, /check, /summary, หรือพิมพ์ "ปี 1", "ปี 2", "ขาด", รหัสนักเรียน 7 หลัก
 */
function handleTelegramWebhook(update) {
  try {
    if (!update) return;

    // 0. ป้องกัน Telegram ส่ง Webhook ซ้ำ (Deduplicate update_id)
    const updateId = update.update_id ? String(update.update_id) : null;
    if (updateId) {
      const cache = CacheService.getScriptCache();
      if (cache.get("tg_upd_" + updateId)) {
        return; // เคยประมวลผลแล้ว ข้ามทันที ไม่ส่งซ้ำ
      }
      cache.put("tg_upd_" + updateId, "1", 600); // จำไว้ 10 นาที
    }

    const msg = update.message || (update.callback_query && update.callback_query.message);
    if (!msg) return;
    const chatId = msg.chat.id;
    let text = String(msg.text || (update.callback_query && update.callback_query.data) || "").trim();

    if (!text) return;

    // ถ้าขึ้นต้นด้วย / ให้ตัด / ออกเพื่อความยืดหยุ่น เช่น /รายงาน ปี 1 -> รายงาน ปี 1
    const cleanText = text.replace(/^\//, "").trim();
    const lower = cleanText.toLowerCase();
    const apiUrl = ScriptApp.getService().getUrl();
    const sheetUrl = "https://docs.google.com/spreadsheets/d/1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ/edit";

    // 1. คำสั่งดึงข้อมูลรายงานผลแยกรายชั้นปี (เช่น "รายงาน ปี 1", "รายงาน", "ปี 1", "ปี 2", "ปี 3", "ปี 4", "year 1", "year1")
    if (lower.indexOf("รายงาน") === 0 || lower.indexOf("year") === 0 || (lower.indexOf("ปี") === 0 && (cleanText.indexOf("1") !== -1 || cleanText.indexOf("2") !== -1 || cleanText.indexOf("3") !== -1 || cleanText.indexOf("4") !== -1))) {
      let targetYear = "69";
      let yearName = "ชั้นปีที่ 1 (รุ่น 69)";
      if (cleanText.indexOf("2") !== -1 || cleanText.indexOf("68") !== -1) { targetYear = "68"; yearName = "ชั้นปีที่ 2 (รุ่น 68)"; }
      else if (cleanText.indexOf("3") !== -1 || cleanText.indexOf("67") !== -1) { targetYear = "67"; yearName = "ชั้นปีที่ 3 (รุ่น 67)"; }
      else if (cleanText.indexOf("4") !== -1 || cleanText.indexOf("66") !== -1) { targetYear = "66"; yearName = "ชั้นปีที่ 4 (รุ่น 66)"; }

      const logs = readTimelineLogs({ year: targetYear });
      const distinctStudents = {};
      logs.forEach(function(l) { 
        if (!distinctStudents[l.studentId]) distinctStudents[l.studentId] = l; 
      });
      const studentCount = Object.keys(distinctStudents).length;

      let yReply = "📑 [รายงานผลประเมินสุขภาพใจ: " + yearName + "]\n" +
        "------------------------------------\n" +
        "• ประเมินแล้วทั้งหมด: " + studentCount + " คน (" + logs.length + " ครั้ง)\n" +
        "------------------------------------\n";

      if (studentCount > 0) {
        yReply += "📋 รายชื่อและผลประเมินล่าสุด:\n";
        Object.values(distinctStudents).slice(0, 15).forEach(function(s, idx) {
          const riskIcon = s.riskLevel === "RED" ? "🔴" : (s.riskLevel === "ORANGE" ? "🟠" : (s.riskLevel === "YELLOW" ? "🟡" : "🟢"));
          yReply += (idx + 1) + ". " + s.studentId + " " + s.displayName + " ➔ " + riskIcon + " " + s.riskLevel + " (ST5:" + s.st5Score + " 9Q:" + (s.q9Score !== "" ? s.q9Score : 0) + " 8Q:" + (s.q8Score !== "" ? s.q8Score : 0) + ")\n";
        });
        if (studentCount > 15) {
          yReply += "... และอีก " + (studentCount - 15) + " คน (ดาวน์โหลดไฟล์เต็มได้ด้านล่าง)\n";
        }
      } else {
        yReply += "⚠️ ยังไม่มีข้อมูลการประเมินในชั้นปีนี้\n";
      }

      const yButtons = {
        inline_keyboard: [
          [
            { text: "📥 โหลดรายงานผล " + yearName + " (CSV)", url: apiUrl + "?report=downloadReport&year=" + targetYear }
          ],
          [
            { text: "⚠️ ดูรายชื่อที่ยังไม่ทำ (" + yearName + ")", url: apiUrl + "?report=missing&year=" + targetYear },
            { text: "📲 ส่ง LINE Flex แจ้งเตือน (" + yearName + ")", url: apiUrl + "?action=pushLineAll&year=" + targetYear }
          ],
          [
            { text: "📊 เปิด Google Sheet", url: sheetUrl }
          ]
        ]
      };

      pushTelegramMessage(yReply, yButtons);
      return;
    }

    // 1.5 คำสั่งสั่งส่ง LINE Flex Message ทันทีผ่าน Telegram (/broadcast, /sendflex, "ส่งไลน์", "บรอดคาสต์")
    if (lower.indexOf("/broadcast") === 0 || lower.indexOf("/sendflex") === 0 || lower.indexOf("/line") === 0 || lower.indexOf("ส่งไลน์") !== -1 || lower.indexOf("บรอดคาสต์") !== -1) {
      let targetYear = "";
      if (cleanText.indexOf("1") !== -1 || cleanText.indexOf("69") !== -1) targetYear = "69";
      else if (cleanText.indexOf("2") !== -1 || cleanText.indexOf("68") !== -1) targetYear = "68";
      else if (cleanText.indexOf("3") !== -1 || cleanText.indexOf("67") !== -1) targetYear = "67";
      else if (cleanText.indexOf("4") !== -1 || cleanText.indexOf("66") !== -1) targetYear = "66";

      const res = pushResultsToAllStudentsLine(targetYear);
      let reply = "📲 [ผลการสั่งส่ง LINE Flex Message]\n" +
        "ระบบดูแลใจ วิทยาลัยพยาบาลทหารอากาศ\n" +
        "------------------------------------\n" +
        (res.ok ? ("✅ " + res.message + "\n") : ("❌ เกิดข้อผิดพลาด: " + res.error + "\n")) +
        (targetYear ? ("🎯 กลุ่มเป้าหมาย: ชั้นปีที่ระบุ (รุ่น " + targetYear + ")\n") : "🎯 กลุ่มเป้าหมาย: นักเรียนทุกคน\n") +
        "• ส่งสำเร็จ: " + (res.sentCount || 0) + " คน\n" +
        "• ยังไม่ผูก LINE ID: " + (res.noLineBindingCount || 0) + " คน\n" +
        "------------------------------------";

      const flexButtons = {
        inline_keyboard: [
          [
            { text: "📊 เปิด Google Sheet", url: sheetUrl },
            { text: "🌐 เปิดระบบดูแลใจ", url: webAppUrl }
          ]
        ]
      };
      pushTelegramMessage(reply, flexButtons);
      return;
    }

    // 2. คำสั่งตรวจสอบรายชื่อคนที่ยังไม่ทำ ("missing", "check", "ขาด", "ยังไม่ทำ", "เช็ค")
    if (lower.indexOf("missing") === 0 || lower.indexOf("check") === 0 || lower.indexOf("ขาด") !== -1 || lower.indexOf("ยังไม่ทำ") !== -1 || lower.indexOf("เช็ค") !== -1) {
      let targetYear = "";
      if (cleanText.indexOf("1") !== -1 || cleanText.indexOf("69") !== -1) targetYear = "69";
      else if (cleanText.indexOf("2") !== -1 || cleanText.indexOf("68") !== -1) targetYear = "68";
      else if (cleanText.indexOf("3") !== -1 || cleanText.indexOf("67") !== -1) targetYear = "67";
      else if (cleanText.indexOf("4") !== -1 || cleanText.indexOf("66") !== -1) targetYear = "66";

      const missingResult = checkMissingStudents(targetYear);
      const yearNames = { "69": "ชั้นปีที่ 1 (รุ่น 69)", "68": "ชั้นปีที่ 2 (รุ่น 68)", "67": "ชั้นปีที่ 3 (รุ่น 67)", "66": "ชั้นปีที่ 4 (รุ่น 66)" };
      const targetLabel = targetYear ? (yearNames[targetYear] || ("รุ่น " + targetYear)) : "นักเรียนทุกชั้นปี";
      
      let reply = "📋 [ตรวจสอบสถานะการทำแบบประเมิน วพอ.พอ.]\n" +
        "🎯 กลุ่มเป้าหมาย: " + targetLabel + "\n" +
        "------------------------------------\n" +
        "• ประเมินแล้ว: " + missingResult.submittedCount + (missingResult.expectedTotal ? ("/" + missingResult.expectedTotal) : "") + " คน\n" +
        "• คงเหลือที่ยังไม่ทำ: " + missingResult.missingCount + " คน\n" +
        "------------------------------------\n";

      if (missingResult.missingList.length > 0) {
        reply += "⚠️ รายชื่อผู้ที่ยังไม่ทำ" + (targetYear ? (" (" + targetLabel + ")") : "") + ":\n";
        missingResult.missingList.slice(0, 20).forEach(function(s, idx) {
          reply += (idx + 1) + ". " + s.id + " " + s.name + " (" + s.year + ")\n";
        });
        if (missingResult.missingList.length > 20) {
          reply += "... และอีก " + (missingResult.missingList.length - 20) + " คน (ดูทั้งหมดในตาราง)\n";
        }
      } else if (missingResult.missingCount === 0) {
        reply += "🎉 ยอดเยี่ยมมาก! ทุกคนในกลุ่มนี้ทำแบบประเมินครบถ้วน 100% แล้วครับ";
      } else {
        reply += "💡 กดปุ่มด้านล่างเพื่อดาวน์โหลดรายชื่อ หรือส่ง LINE ติดตามได้ทันที";
      }

      const buttons = {
        inline_keyboard: [
          [
            { text: "📥 โหลดรายชื่อคนที่ยังไม่ทำ (CSV)", url: apiUrl + "?report=missing&year=" + targetYear }
          ],
          [
            { text: "📊 เปิด Google Sheet", url: sheetUrl }
          ]
        ]
      };

      pushTelegramMessage(reply, buttons);
      return;
    }

    // 3. คำสั่งสรุปภาพรวม ("summary", "สรุป", "ภาพรวม")
    if (lower.indexOf("summary") === 0 || lower.indexOf("สรุป") !== -1 || lower.indexOf("ภาพรวม") !== -1) {
      const rep = buildWatchReport(7);
      const sumText = "📊 [รายงานสรุปภาพรวมสุขภาพใจ 7 วันล่าสุด]\n" +
        "ระบบดูแลใจ วพอ.พอ.\n" +
        "------------------------------------\n" +
        "• ทำแบบประเมินทั้งหมด: " + rep.total + " ครั้ง\n" +
        "🔴 เสี่ยงสูงสุด (RED): " + rep.byRisk.RED + " คน\n" +
        "🟠 สำคัญ (ORANGE): " + rep.byRisk.ORANGE + " คน\n" +
        "🟡 ควรชวนคุย (YELLOW): " + rep.byRisk.YELLOW + " คน\n" +
        "🟢 ปกติ (GREEN): " + rep.byRisk.GREEN + " คน\n" +
        "📷 สัญญาณขัดแย้งกล้อง AI: " + rep.cameraConflicts + " ครั้ง\n" +
        "------------------------------------\n" +
        "👉 คลิกปุ่มด้านล่างเพื่อดาวน์โหลดเอกสารรายงาน:";

      const sumButtons = {
        inline_keyboard: [
          [
            { text: "📥 โหลดรายงาน 🔴 RED", url: apiUrl + "?report=downloadReport&level=RED" },
            { text: "📥 โหลดรายงาน 🟠 ORANGE", url: apiUrl + "?report=downloadReport&level=ORANGE" }
          ],
          [
            { text: "📥 โหลดรายงาน 🟡 YELLOW", url: apiUrl + "?report=downloadReport&level=YELLOW" },
            { text: "📥 โหลดรายงานทั้งหมด (CSV)", url: apiUrl + "?report=downloadReport&days=7" }
          ],
          [
            { text: "📊 เปิด Google Sheet", url: sheetUrl }
          ]
        ]
      };

      pushTelegramMessage(sumText, sumButtons);
      return;
    }

    // 4. ถ้าพิมพ์รหัสนักเรียน 7 หลักมาตรงๆ -> ดึงประวัติรายคนส่งกลับให้ทันที
    if (/^\d{7}$/.test(cleanText)) {
      const studentId = cleanText;
      const logs = readTimelineLogs({ studentId: studentId });
      const roster = rosterMap();
      const info = roster[studentId] || {};
      
      let sReply = "👤 [ข้อมูลประวัติสุขภาพใจรายบุคคล]\n" +
        "------------------------------------\n" +
        "• รหัสนักเรียน: " + studentId + "\n" +
        "• ชื่อ-สกุล: " + (info.name || "ในทะเบียน") + " (" + (info.year || "-") + ")\n" +
        "• ประวัติการประเมิน: ทำทั้งหมด " + logs.length + " ครั้ง\n";

      if (logs.length > 0) {
        const last = logs[0];
        sReply += "• ครั้งล่าสุดเมื่อ: " + last.timestamp + "\n" +
          "• ระดับความเสี่ยง: " + last.riskLevel + "\n" +
          "• คะแนน: ST-5=" + last.st5Score + " | 2Q=" + last.q2Score + " | 9Q=" + last.q9Score + " | 8Q=" + last.q8Score + "\n" +
          "• ผลประเมิน: " + last.reason + "\n";
      } else {
        sReply += "⚠️ ยังไม่มีประวัติการทำแบบประเมินในระบบ\n";
      }

      const sButtons = {
        inline_keyboard: [
          [
            { text: "📲 ส่ง LINE Flex การ์ดให้นักเรียนคนนี้", url: apiUrl + "?action=pushStudent&id=" + studentId }
          ],
          [
            { text: "📥 โหลดไฟล์รายงานรายคน (CSV)", url: apiUrl + "?report=student&id=" + studentId },
            { text: "📊 เปิด Google Sheet", url: sheetUrl }
          ]
        ]
      };

      pushTelegramMessage(sReply, sButtons);
      return;
    }

  } catch (err) {
    logError("handleTelegramWebhook", err, "");
  }
}

/**
 * ตรวจสอบรายชื่อนักเรียนที่ยังไม่ได้ทำแบบประเมิน
 * หากชีต Roster ว่าง -> ใช้สถิติยอดประเมินรวมตามชั้นปีแทนอย่างแม่นยำ
 */
function checkMissingStudents(yearFilter) {
  const rosterSheet = getSheet(SHEETS.ROSTER);
  const rRows = rosterSheet.getDataRange().getValues();
  const data = loadAssessments();

  // กำหนดจำนวนนักเรียนเต็มของแต่ละชั้นปี วพอ.พอ. (Baseline Capacity)
  // ปี 1 (รุ่น 69) = 54 คน, ปี 2 (รุ่น 68) = 60 คน, ปี 3 (รุ่น 67) = 65 คน, ปี 4 (รุ่น 66) = 46 คน (รวม ~225 คน)
  const EXPECTED_PER_YEAR = { "69": 54, "68": 60, "67": 65, "66": 46 };

  const submittedSet = {};
  const submittedByYear = { "69": {}, "68": {}, "67": {}, "66": {} };

  data.forEach(function (a) {
    if (!a.studentId) return;
    const sId = String(a.studentId).trim();
    if (/^\d{7}$/.test(sId)) {
      submittedSet[sId] = true;
      const prefix = sId.substring(0, 2);
      if (submittedByYear[prefix]) submittedByYear[prefix][sId] = true;
    }
  });

  const missingList = [];
  let submittedCount = 0;
  let hasValidRoster = false;

  for (let i = 1; i < rRows.length; i++) {
    let sId = "";
    let name = "";
    let year = "";

    for (let c = 0; c < 3; c++) {
      const val = String(rRows[i][c] || "").trim();
      if (/^\d{7}$/.test(val)) {
        sId = val;
        name = rRows[i][c + 1] || "";
        year = rRows[i][c + 2] || "";
        break;
      }
    }

    if (!sId) continue;
    hasValidRoster = true;
    if (yearFilter && sId.indexOf(yearFilter) !== 0 && String(year).indexOf(yearFilter) === -1) continue;

    if (submittedSet[sId]) {
      submittedCount++;
    } else {
      missingList.push({ id: sId, name: name, year: year });
    }
  }

  // ถ้าระบบยังไม่มีรายชื่อในชีต Roster -> ใช้ยอดประเมินจริงแยกตามชั้นปี
  if (!hasValidRoster) {
    if (yearFilter && submittedByYear[yearFilter]) {
      submittedCount = Object.keys(submittedByYear[yearFilter]).length;
      const exp = EXPECTED_PER_YEAR[yearFilter] || submittedCount;
      const diff = Math.max(0, exp - submittedCount);
      return {
        submittedCount: submittedCount,
        missingCount: diff,
        missingList: [],
        expectedTotal: exp
      };
    } else {
      submittedCount = Object.keys(submittedSet).length;
      const totalExp = Object.values(EXPECTED_PER_YEAR).reduce(function(a, b) { return a + b; }, 0);
      const totalMissing = Math.max(0, totalExp - submittedCount);
      return {
        submittedCount: submittedCount,
        missingCount: totalMissing,
        missingList: [],
        expectedTotal: totalExp
      };
    }
  }

  // เรียงลำดับรหัสนักเรียนจากน้อยไปมาก
  missingList.sort(function (a, b) {
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    submittedCount: submittedCount,
    missingCount: missingList.length,
    missingList: missingList
  };
}

function doGet(e) {
  const p = e ? e.parameter : {};
  const action = p.action || p.report;

  // 1. ดาวน์โหลดรายชื่อนักเรียนที่ยังไม่ได้ทำแบบประเมิน (Missing Students CSV)
  if (action === "missing" || action === "downloadMissingReport") {
    const filterYear = (p.year || "").trim();
    const missingData = checkMissingStudents(filterYear);
    const headers = ["ลำดับ", "รหัสประจำตัว", "ยศ-ชื่อ-สกุล", "ชั้นปี/รุ่น", "สถานะ"];
    const rows = [headers];
    missingData.missingList.forEach(function(s, idx) {
      rows.push([idx + 1, '="' + String(s.id) + '"', '"' + s.name + '"', '"' + (s.year || "-") + '"', "ยังไม่ทำแบบประเมิน"]);
    });
    const csvContent = "\uFEFF" + rows.map(function (r) { return r.join(","); }).join("\r\n");
    const filename = "MindCare_Missing_Students_" + (filterYear ? ("Year" + filterYear) : "All") + "_" +
      Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd_HHmm") + ".csv";
    
    return ContentService.createTextOutput(csvContent)
      .setMimeType(ContentService.MimeType.CSV)
      .downloadAsFile(filename);
  }

  // 2. อ่าน Log / ประวัติผลประเมินตามช่วงเวลา (Read Log Timeline) ในรูปแบบ JSON API
  if (action === "readLog" || action === "timeline") {
    const logs = readTimelineLogs(p);
    return output({
      ok: true,
      filter: {
        days: p.days || "all",
        level: p.level || "all",
        year: p.year || "all",
        studentId: p.studentId || "all"
      },
      count: logs.length,
      logs: logs
    });
  }

  // 2.1 ตรวจสอบสถานะการผูก LINE ID และทะเบียนนักเรียน
  if (action === "debugBindings" || action === "checkBindings") {
    const ss = getActiveSpreadsheet();
    const allSheets = ss.getSheets().map(function(s) {
      return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() };
    });

    const bindRows = getSheet(SHEETS.BINDINGS).getDataRange().getValues();
    const rosterRows = getSheet(SHEETS.ROSTER).getDataRange().getValues();
    const assessRows = getSheet(SHEETS.ASSESSMENTS).getDataRange().getValues();

    let assessWithLine = 0;
    for (let a = 1; a < assessRows.length; a++) {
      if (assessRows[a][3]) assessWithLine++;
    }

    return output({
      ok: true,
      spreadsheetId: ss.getId(),
      allSheetsInFile: allSheets,
      totalBindingsInSheet: bindRows.length - 1,
      totalRoster: rosterRows.length - 1,
      totalAssessments: assessRows.length - 1,
      assessmentsWithLineId: assessWithLine,
      sampleAssessmentsTop5: assessRows.slice(Math.max(1, assessRows.length - 5)).map(function(r) {
        return { date: r[0], id: r[2], name: r[16], risk: r[13], st5: r[4] };
      })
    });
  }

  // 2. ดาวน์โหลดรายงานรายบุคคล (Individual Student Report)
  if (action === "student" || action === "downloadStudentReport" || (p.studentId && !action)) {
    const targetId = String(p.studentId || p.id || "").trim();
    const csvContent = generateStudentReportCsv(targetId);
    const filename = "MindCare_Student_" + (targetId || "Report") + "_" +
      Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd_HHmm") + ".csv";
    
    return ContentService.createTextOutput(csvContent)
      .setMimeType(ContentService.MimeType.CSV)
      .downloadAsFile(filename);
  }

  // 3. ดาวน์โหลดรายงานสรุปตามเงื่อนไข Time-line (วันย้อนหลัง/ช่วงวัน), ระดับความเสี่ยง, หรือชั้นปี
  if (action === "downloadReport" || action === "exportCsv" || action === "report") {
    const filterLevel = (p.level || "").toUpperCase(); // RED, ORANGE, YELLOW, หรือ ว่าง=ทั้งหมด
    const filterYear = (p.year || "").trim();          // กรองตามชั้นปี (เช่น ปี 1, ปี 2, 69)
    const days = p.days ? Number(p.days) : null;       // กรอง N วันย้อนหลัง เช่น 1, 7, 30
    const csvContent = generateReportCsv(filterLevel, filterYear, days);
    const filename = "MindCare_Report_" + (filterLevel || "ALL") +
      (filterYear ? ("_Year" + filterYear) : "") +
      (days ? ("_" + days + "Days") : "") + "_" +
      Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd_HHmm") + ".csv";
    
    return ContentService.createTextOutput(csvContent)
      .setMimeType(ContentService.MimeType.CSV)
      .downloadAsFile(filename);
  }

  // 4. ดาวน์โหลดรายงานในรูปแบบไฟล์ Microsoft Excel (.xlsx) โดยตรงจาก Spreadsheet
  if (action === "xlsx" || action === "downloadExcel" || action === "excel") {
    const spreadsheetId = "1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ";
    const exportXlsxUrl = "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/export?format=xlsx";
    return HtmlService.createHtmlOutput(
      '<html><head><meta http-equiv="refresh" content="0; url=' + exportXlsxUrl + '"></head>' +
      '<body style="font-family:sans-serif; text-align:center; padding:40px;">' +
      '<h2>กำลังเตรียมไฟล์ Microsoft Excel (.xlsx)...</h2>' +
      '<p>หากการดาวน์โหลดไม่เริ่มอัตโนมัติ <a href="' + exportXlsxUrl + '">คลิกที่นี่เพื่อดาวน์โหลด</a></p>' +
      '</body></html>'
    );
  }

  // 5. ส่งผลประเมินส่วนตัวกลับไปยัง LINE ID ของนักเรียนทุกคนที่ผูกบัญชีไว้
  if (action === "pushLineAll" || action === "sendLineToStudents") {
    const result = pushResultsToAllStudentsLine(p.year);
    return output(result);
  }

  // 5.1 ส่งผลประเมินเฉพาะรายบุคคลที่อาจารย์ระบุไปยัง LINE ของนักเรียนคนนั้น
  if (action === "pushStudent" || action === "sendStudentLine") {
    const sId = (p.id || p.studentId || "").trim();
    const result = pushSingleStudentLine(sId);
    return output(result);
  }

  // 6. หน้าเว็บช่วยกรอก/บันทึก LINE_CHANNEL_ACCESS_TOKEN ได้โดยตรงอย่างง่ายดาย
  if (action === "setToken" || action === "setupToken") {
    if (p.token) {
      PropertiesService.getScriptProperties().setProperty("LINE_CHANNEL_ACCESS_TOKEN", p.token.trim());
      return HtmlService.createHtmlOutput(
        '<body style="font-family:sans-serif; text-align:center; padding:40px; background:#F0FDF4;">' +
        '<h2 style="color:#1B4332;">✅ บันทึก LINE Channel Access Token เรียบร้อยแล้ว!</h2>' +
        '<p style="color:#4B5563;">ระบบพร้อมส่งแจ้งเตือนและ LINE Flex Message ให้นักเรียนทุกคนแล้วครับ</p>' +
        '<a href="?action=pushLineAll" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#1B4332; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold;">📲 กดส่งผลเข้า LINE นักเรียนทุกคนทันที</a>' +
        '</body>'
      );
    }
    return HtmlService.createHtmlOutput(
      '<body style="font-family:sans-serif; text-align:center; padding:40px; background:#F8FAFC;">' +
      '<div style="max-width:550px; margin:0 auto; background:#fff; padding:30px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.1); text-align:left;">' +
      '<h2 style="color:#1E293B; margin-top:0; text-align:center;">🔑 ตั้งค่า LINE Channel Access Token</h2>' +
      '<p style="color:#64748B; font-size:14px; text-align:center;">วาง Channel access token (long-lived) ที่ได้จากฟ้าใสลงในช่องด้านล่าง</p>' +
      '<textarea id="tokenInput" rows="7" style="width:100%; box-sizing:border-box; padding:12px; border:1px solid #CBD5E1; border-radius:8px; font-family:monospace; font-size:12px; resize:vertical;" placeholder="วาง Channel Access Token ที่นี่..."></textarea>' +
      '<button id="saveBtn" onclick="saveToken()" style="margin-top:16px; width:100%; padding:14px; background:#059669; color:#fff; border:none; border-radius:8px; font-weight:bold; font-size:16px; cursor:pointer;">💾 บันทึก Token</button>' +
      '<div id="resultMsg" style="display:none; margin-top:20px; padding:16px; border-radius:8px; text-align:center;"></div>' +
      '</div>' +
      '<script>' +
      'async function saveToken() {' +
      '  const val = document.getElementById("tokenInput").value.trim();' +
      '  if (!val) { alert("กรุณาวาง Token ก่อนกดบันทึกครับ"); return; }' +
      '  const btn = document.getElementById("saveBtn");' +
      '  const msg = document.getElementById("resultMsg");' +
      '  btn.disabled = true; btn.innerText = "⏳ กำลังบันทึก...";' +
      '  try {' +
      '    const resp = await fetch(window.location.href.split("?")[0], {' +
      '      method: "POST",' +
      '      body: JSON.stringify({ action: "setToken", token: val })' +
      '    });' +
      '    const res = await resp.json();' +
      '    if (res.ok) {' +
      '      msg.style.display = "block";' +
      '      msg.style.background = "#DCFCE7"; msg.style.color = "#166534";' +
      '      msg.innerHTML = "<b>✅ บันทึกสำเร็จเรียบร้อยแล้ว!</b><br><br><a href=\'?action=pushLineAll\' style=\'display:inline-block; padding:10px 18px; background:#166534; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold;\'>📲 กดส่งผลเข้า LINE นักเรียนทุกคนทันที</a>";' +
      '      btn.style.display = "none";' +
      '    } else {' +
      '      alert("เกิดข้อผิดพลาด: " + (res.error || "บันทึกไม่สำเร็จ"));' +
      '      btn.disabled = false; btn.innerText = "💾 บันทึก Token";' +
      '    }' +
      '  } catch (err) {' +
      '    window.location.href = window.location.href.split("?")[0] + "?action=setToken&token=" + encodeURIComponent(val);' +
      '  }' +
      '}' +
      '</script>' +
      '</body>'
    );
  }

  // 6.01 ตรวจสอบรายชื่อนักเรียนที่ยังไม่ได้ทำแบบประเมิน แยกตามชั้นปี ๑-๔
  if (action === "missingStudents" || action === "checkMissing" || action === "uncompleted") {
    const ss = getActiveSpreadsheet();
    const assessRows = getSheet(SHEETS.ASSESSMENTS).getDataRange().getValues();
    
    // เก็บรหัสและชื่อของคนที่ทำแล้ว
    const completedMap = {};
    for (let a = 1; a < assessRows.length; a++) {
      const sId = String(assessRows[a][2] || "").trim();
      const sName = String(assessRows[a][16] || "").trim();
      if (sId) completedMap[sId] = true;
      if (sName) completedMap[sName] = true;
    }

    const yearSheets = [
      { sheetName: "ทะเบียน ปี 1", yearName: "ชั้นปีที่ ๑ (รุ่น ๖๙)", codePrefix: "69" },
      { sheetName: "ทะเบียน ปี 2", yearName: "ชั้นปีที่ ๒ (รุ่น ๖๘)", codePrefix: "68" },
      { sheetName: "ทะเบียน ปี 3", yearName: "ชั้นปีที่ ๓ (รุ่น ๖๗)", codePrefix: "67" },
      { sheetName: "ทะเบียน ปี 4", yearName: "ชั้นปีที่ ๔ (รุ่น ๖๖)", codePrefix: "66" }
    ];

    const result = {
      ok: true,
      totalAssessments: assessRows.length - 1,
      totalCompletedUnique: Object.keys(completedMap).length,
      byYear: {}
    };

    let grandTotalRoster = 0;
    let grandTotalMissing = 0;

    yearSheets.forEach(function(y) {
      const sh = ss.getSheetByName(y.sheetName);
      if (!sh) return;
      const rows = sh.getDataRange().getValues();
      const rosterList = [];
      const missingList = [];
      const doneList = [];

      // หา header column
      let idCol = 1; // Default col B
      let nameCol = 2; // Default col C

      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          const val = String(rows[r][c] || "").trim();
          if (val.indexOf("รหัสประจำตัว") !== -1 || val.indexOf("รหัส") !== -1) idCol = c;
          if (val.indexOf("ชื่อ") !== -1 || val.indexOf("ยศ-ชื่อ") !== -1) nameCol = c;
        }
        if (rows[r][0] === "ลำดับ" || rows[r][1] === "รหัสประจำตัว") {
          // Found header
          break;
        }
      }

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const sId = String(row[idCol] || "").trim();
        const sName = String(row[nameCol] || "").trim();
        
        // ข้ามแถว header หรือแถวว่าง
        if (!sId || sId === "รหัสประจำตัว" || sId.length < 5 || isNaN(Number(sId.substring(0, 2)))) continue;

        const stuObj = {
          studentId: sId,
          name: sName,
          gender: row[4] || "-",
          section: row[3] || "-"
        };
        rosterList.push(stuObj);

        // เช็คว่าทำหรือยัง
        if (completedMap[sId] || (sName && completedMap[sName])) {
          doneList.push(stuObj);
        } else {
          missingList.push(stuObj);
        }
      }

      grandTotalRoster += rosterList.length;
      grandTotalMissing += missingList.length;

      result.byYear[y.yearName] = {
        totalRoster: rosterList.length,
        completedCount: doneList.length,
        missingCount: missingList.length,
        completionRate: rosterList.length ? (Math.round(doneList.length / rosterList.length * 1000) / 10 + "%") : "0%",
        missingStudents: missingList
      };
    });

    result.grandTotalRoster = grandTotalRoster;
    result.grandTotalMissing = grandTotalMissing;
    result.grandTotalCompleted = grandTotalRoster - grandTotalMissing;
    result.overallCompletionRate = grandTotalRoster ? (Math.round((grandTotalRoster - grandTotalMissing) / grandTotalRoster * 1000) / 10 + "%") : "0%";

    if (p.format === "json") {
      return output(result);
    }

    // สร้างหน้า Web Dashboard แสดงผลอย่างสวยงามแบบมืออาชีพ
    let html = '<!DOCTYPE html>' +
      '<html lang="th">' +
      '<head>' +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<title>รายชื่อ นพอ. ที่ยังไม่ได้ทำแบบประเมิน | ระบบดูแลใจ วพอ.พอ.</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700&display=swap" rel="stylesheet">' +
      '<style>' +
      '* { box-sizing: border-box; margin: 0; padding: 0; }' +
      'body { font-family: "Sarabun", sans-serif; background: #F1F5F9; color: #1E293B; padding: 20px 12px; }' +
      '.container { max-width: 900px; margin: 0 auto; }' +
      '.header-card { background: linear-gradient(135deg, #1F3864 0%, #2E75B6 100%); color: #fff; padding: 24px; border-radius: 16px; box-shadow: 0 10px 25px rgba(31, 56, 100, 0.2); text-align: center; margin-bottom: 20px; }' +
      '.header-card h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }' +
      '.header-card p { font-size: 14px; opacity: 0.9; }' +
      '.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 20px; }' +
      '.stat-card { background: #fff; padding: 16px 12px; border-radius: 12px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.04); border: 1px solid #E2E8F0; }' +
      '.stat-card .val { font-size: 24px; font-weight: 700; color: #1F3864; margin-top: 4px; }' +
      '.stat-card.red .val { color: #DC2626; }' +
      '.stat-card.green .val { color: #16A34A; }' +
      '.stat-card .lbl { font-size: 13px; color: #64748B; }' +
      '.year-card { background: #fff; border-radius: 14px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); border: 1px solid #E2E8F0; }' +
      '.year-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #F1F5F9; padding-bottom: 12px; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }' +
      '.year-title { font-size: 17px; font-weight: 700; color: #1F3864; }' +
      '.badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; }' +
      '.badge.warn { background: #FEF2F2; color: #DC2626; border: 1px solid #FCA5A5; }' +
      '.badge.ok { background: #F0FDF4; color: #16A34A; border: 1px solid #86EFAC; }' +
      'table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }' +
      'th { background: #F8FAFC; color: #475569; text-align: left; padding: 10px; font-weight: 600; border-bottom: 1px solid #E2E8F0; }' +
      'td { padding: 10px; border-bottom: 1px solid #F1F5F9; color: #334155; }' +
      'tr:hover { background: #F8FAFC; }' +
      '.btn-group { display: flex; justify-content: center; gap: 10px; margin-top: 24px; flex-wrap: wrap; }' +
      '.btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 20px; border-radius: 10px; font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; transition: 0.2s; }' +
      '.btn-primary { background: #1F3864; color: #fff; }' +
      '.btn-primary:hover { background: #152644; }' +
      '.btn-outline { background: #fff; color: #1F3864; border: 1px solid #CBD5E1; }' +
      '</style>' +
      '</head>' +
      '<body>' +
      '<div class="container">' +
      '<div class="header-card">' +
      '<h1>📋 ติดตามการทำแบบประเมินสุขภาพใจ นพอ.</h1>' +
      '<p>วิทยาลัยพยาบาลทหารอากาศ กรมแพทย์ทหารอากาศ</p>' +
      '</div>' +
      '<div class="stats-grid">' +
      '<div class="stat-card"><div class="lbl">นพอ. ในทะเบียนทั้งหมด</div><div class="val">' + result.grandTotalRoster + ' <span style="font-size:14px;font-weight:normal;">นาย</span></div></div>' +
      '<div class="stat-card green"><div class="lbl">ทำแบบประเมินแล้ว</div><div class="val">' + result.grandTotalCompleted + ' <span style="font-size:14px;font-weight:normal;">นาย</span></div></div>' +
      '<div class="stat-card red"><div class="lbl">ยังไม่ได้ทำ</div><div class="val">' + result.grandTotalMissing + ' <span style="font-size:14px;font-weight:normal;">นาย</span></div></div>' +
      '<div class="stat-card"><div class="lbl">อัตราความสำเร็จ</div><div class="val">' + result.overallCompletionRate + '</div></div>' +
      '</div>';

    Object.keys(result.byYear).forEach(function(yName) {
      const yData = result.byYear[yName];
      html += '<div class="year-card">' +
        '<div class="year-header">' +
        '<div class="year-title">🎓 ' + yName + '</div>' +
        '<div class="badge ' + (yData.missingCount > 0 ? 'warn' : 'ok') + '">' +
        (yData.missingCount > 0 ? ('ขาดอีก ' + yData.missingCount + ' นาย (' + yData.completionRate + ')') : 'ครบ 100%') +
        '</div>' +
        '</div>';

      if (yData.missingStudents.length === 0) {
        html += '<p style="color:#16A34A; text-align:center; padding:12px 0;">🎉 นพอ. ในชั้นปีนี้ทำแบบประเมินครบถ้วน 100% แล้ว</p>';
      } else {
        html += '<table>' +
          '<thead><tr><th style="width:60px;text-align:center;">ลำดับ</th><th style="width:120px;">รหัสประจำตัว</th><th>ยศ-ชื่อ-สกุล</th></tr></thead>' +
          '<tbody>';
        yData.missingStudents.forEach(function(s, idx) {
          html += '<tr>' +
            '<td style="text-align:center;color:#64748B;">' + (idx + 1) + '</td>' +
            '<td style="font-weight:600;color:#1F3864;">' + s.studentId + '</td>' +
            '<td>' + s.name + '</td>' +
            '</tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    });

    html += '<div class="btn-group">' +
      '<a href="https://docs.google.com/spreadsheets/d/1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ/edit" target="_blank" class="btn btn-primary">📊 เปิด Google Sheet บันทึกผล</a>' +
      '<a href="https://liff.line.me/2010984231-Z7kbSIPp" target="_blank" class="btn btn-outline">🌐 ลิงก์แบบประเมิน (LIFF)</a>' +
      '</div>' +
      '<p style="text-align:center; margin-top:20px; font-size:12px; color:#94A3B8;">ระบบดูแลใจ AI Smart Health Surveillance System • วพอ.พอ.</p>' +
      '</div>' +
      '</body>' +
      '</html>';

    return HtmlService.createHtmlOutput(html).setTitle("รายชื่อ นพอ. ที่ยังไม่ได้ทำแบบประเมิน | วพอ.พอ.");
  }

  // 6.0 คำสั่งย้ายและซิงค์ข้อมูลทั้งหมด 262 รายการจากชีตเดิมเข้าสู่ชีตหลักนี้
  if (action === "migrateData" || action === "syncAllData") {
    const srcSs = SpreadsheetApp.openById("1iVop4KAdgMFxcoGe3qbjI5-zDPo1jPllTeDx_7Xdjh4");
    const dstSs = SpreadsheetApp.openById("1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ");
    
    const srcAssess = srcSs.getSheetByName("Assessments").getDataRange().getValues();
    const dstAssess = dstSs.getSheetByName("Assessments");
    
    // เติมข้อมูลที่ยังไม่มี
    const existingAssess = dstAssess.getDataRange().getValues();
    const existingIds = {};
    for (let e = 1; e < existingAssess.length; e++) {
      existingIds[String(existingAssess[e][1]).trim()] = true;
    }
    
    let addedCount = 0;
    for (let s = 1; s < srcAssess.length; s++) {
      const aId = String(srcAssess[s][1]).trim();
      if (!existingIds[aId]) {
        dstAssess.appendRow(srcAssess[s]);
        addedCount++;
      }
    }
    
    // ซิงค์ Alerts
    const srcAlerts = srcSs.getSheetByName("Alerts").getDataRange().getValues();
    const dstAlerts = dstSs.getSheetByName("Alerts");
    const existingAl = dstAlerts.getDataRange().getValues();
    const exAlIds = {};
    for (let a = 1; a < existingAl.length; a++) exAlIds[String(existingAl[a][1]).trim()] = true;
    for (let sa = 1; sa < srcAlerts.length; sa++) {
      const alId = String(srcAlerts[sa][1]).trim();
      if (!exAlIds[alId]) dstAlerts.appendRow(srcAlerts[sa]);
    }

    // ซิงค์ Bindings
    const srcBindings = srcSs.getSheetByName("Bindings").getDataRange().getValues();
    const dstBindings = dstSs.getSheetByName("Bindings");
    const existingB = dstBindings.getDataRange().getValues();
    const exBMap = {};
    for (let b = 1; b < existingB.length; b++) exBMap[String(existingB[b][0]).trim()] = true;
    for (let sb = 1; sb < srcBindings.length; sb++) {
      const bId = String(srcBindings[sb][0]).trim();
      if (bId && !exBMap[bId]) dstBindings.appendRow(srcBindings[sb]);
    }
    
    // สร้างแท็บรายงานใหม่ทั้งหมด
    buildAllSheetReports();
    
    return output({
      ok: true,
      message: "ซิงค์ข้อมูลครบถ้วนเข้าสู่ Google Sheet เรียบร้อยแล้ว",
      addedAssessments: addedCount,
      totalAssessmentsInSheet: dstAssess.getLastRow() - 1,
      sheetUrl: "https://docs.google.com/spreadsheets/d/1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ/edit"
    });
  }

  // 6.1 คำสั่งสั่งอัปเดตแท็บรายงานทั้งหมดใน Google Sheet ทันที (สร้างชีตสรุปรายชั้นปี, รายบุคคล, กลุ่มเสี่ยง)
  if (action === "rebuildSheets" || action === "buildReports" || action === "updateReports") {
    const y = buildYearReport();
    const pCount = buildPersonReport();
    const r = buildRiskReport();
    return output({
      ok: true,
      message: "อัปเดตแท็บรายงานใน Google Sheet สำเร็จเรียบร้อยแล้ว",
      yearGroups: y,
      students: pCount,
      riskCases: r,
      sheetUrl: "https://docs.google.com/spreadsheets/d/1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ/edit"
    });
  }

  // 7. ขอไฟล์เอกสารรายงาน Excel (.xlsx) ที่จัดเก็บใน Google Drive
  if (action === "exportDrive" || action === "getReportUrl") {
    const res = exportReportNow(Number(p.days || 7));
    return output(res);
  }

  // 8. หน้าทดสอบระบบอัตโนมัติ (Self-Test Diagnostics)
  if (action === "test" || action === "selfTest") {
    const testResult = runSelfTest();
    return HtmlService.createHtmlOutput(
      '<body style="font-family:monospace; background:#0F172A; color:#E2E8F0; padding:30px; line-height:1.6;">' +
      '<h2 style="color:#38BDF8;">🧪 ผลการทดสอบระบบดูแลใจ (Self-Test Report)</h2>' +
      '<pre style="background:#1E293B; padding:20px; border-radius:8px; border:1px solid #334155; white-space:pre-wrap;">' +
      testResult +
      '</pre>' +
      '<br>' +
      '<a href="?action=pushLineAll" style="padding:10px 20px; background:#059669; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold; font-family:sans-serif;">📲 ทดสอบส่ง LINE บรอดคาสต์</a>' +
      '</body>'
    );
  }

  return output({
    ok: true,
    status: "RTAFNC MindCare API is running",
    endpoints: {
      readLogTimeline: "?action=readLog&days=7",
      readLogByStudent: "?action=readLog&studentId=6903946",
      downloadReportAll: "?report=downloadReport",
      downloadReportTimeline: "?report=downloadReport&days=7",
      downloadReportRed: "?report=downloadReport&level=RED",
      downloadReportOrange: "?report=downloadReport&level=ORANGE",
      downloadReportYellow: "?report=downloadReport&level=YELLOW",
      downloadReportByYear: "?report=downloadReport&year=1",
      downloadReportByStudent: "?report=student&id=6903946",
      exportDriveExcel: "?action=exportDrive&days=7"
    }
  });
}

/**
 * ฟังก์ชันอ่าน Log ประวัติการประเมินตาม Timeline และเงื่อนไขที่กำหนด
 */
function readTimelineLogs(params) {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();

  const days = params.days ? Number(params.days) : null;
  const level = (params.level || "").toUpperCase();
  const year = (params.year || "").trim();
  const studentId = String(params.studentId || params.id || "").trim();
  const now = new Date();
  const since = days ? new Date(now.getTime() - days * 86400 * 1000) : null;

  return data
    .filter(function (a) {
      if (since && new Date(a.ts) < since) return false;
      if (level && level !== "ALL" && a.level !== level) return false;
      if (studentId && String(a.studentId).trim() !== studentId) return false;
      if (year) {
        const info = roster[a.studentId];
        const y = info && info.year ? String(info.year) : String(a.studentId || "").substring(0, 2);
        if (y.indexOf(year) === -1) return false;
      }
      return true;
    })
    .sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); }) // Timeline ใหม่สุดก่อน
    .map(function (a) {
      const info = roster[a.studentId] || {};
      const al = alerts[a.studentId] || {};
      return {
        timestamp: Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss"),
        studentId: a.studentId,
        displayName: info.name || a.name || "-",
        year: info.year || "-",
        riskLevel: a.level,
        st5Score: a.st5,
        q2Score: a.q2,
        q9Score: a.q9,
        q8Score: a.q8,
        cameraIndex: a.camIndex,
        conflictFlag: a.conflict,
        reason: a.reason,
        alertStatus: al.status || "-"
      };
    });
}

/**
 * สร้างข้อมูล CSV รายงานประวัติรายบุคคลของนักเรียนคนนั้น
 */
function generateStudentReportCsv(studentId) {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();

  let list = data;
  if (studentId) {
    list = data.filter(function (a) { return String(a.studentId).trim() === studentId; });
  }

  // เรียงลำดับประวัติ: Timeline เวลาล่าสุดก่อน
  list.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });

  const info = roster[studentId] || {};
  const al = alerts[studentId] || {};

  const headers = [
    "ครั้งที่", "วันเวลาประเมิน", "รหัสประจำตัว", "ชื่อ-สกุล", "ชั้นปี/รุ่น",
    "ระดับความเสี่ยง", "ST-5 (เครียด)", "2Q (คัดกรอง)", "9Q (ซึมเศร้า)", "8Q (ทำร้ายตนเอง)",
    "ดัชนีกล้อง AI", "สัญญาณขัดแย้ง", "เหตุผลความเสี่ยง", "สถานะติดตามงาน"
  ];

  const rows = [headers];
  list.forEach(function (a, idx) {
    rows.push([
      list.length - idx,
      Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss"),
      a.studentId,
      info.name ? info.name : (a.name || "-"),
      info.year ? info.year : "-",
      a.level,
      a.st5 !== null && a.st5 !== undefined ? a.st5 : "-",
      a.q2 !== null && a.q2 !== undefined ? a.q2 : "-",
      a.q9 !== null && a.q9 !== undefined ? a.q9 : "-",
      a.q8 !== null && a.q8 !== undefined ? a.q8 : "-",
      a.camIndex !== null && a.camIndex !== undefined ? a.camIndex : "-",
      a.conflict ? "พบสัญญาณขัดแย้ง" : "ปกติ",
      '"' + String(a.reason || "").replace(/"/g, '""') + '"',
      al.status ? al.status : "-"
    ]);
  });

  return "\uFEFF" + rows.map(function (r) { return r.join(","); }).join("\r\n");
}

/**
 * สร้างข้อมูล CSV รายงานตาม Timeline, ระดับความเสี่ยง, และ/หรือ ชั้นปี
 * ดึงเฉพาะผลประเมินครั้งล่าสุดของแต่ละคน (Deduplicate per Student)
 */
function generateReportCsv(filterLevel, filterYear, filterDays) {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();
  const now = new Date();
  const since = filterDays ? new Date(now.getTime() - filterDays * 86400 * 1000) : null;

  // 1. ดึงเฉพาะผลประเมินครั้งล่าสุด 1 คน ต่อ 1 รายการ
  const latestMap = {};
  data.forEach(function (a) {
    if (!a.studentId) return;
    const sId = String(a.studentId).trim();
    if (!latestMap[sId] || new Date(a.ts) > new Date(latestMap[sId].ts)) {
      latestMap[sId] = a;
    }
  });

  let filtered = Object.values(latestMap);
  if (since) {
    filtered = filtered.filter(function (a) { return new Date(a.ts) >= since; });
  }
  if (filterLevel && filterLevel !== "ALL") {
    filtered = filtered.filter(function (a) { return a.level === filterLevel; });
  }
  if (filterYear) {
    filtered = filtered.filter(function (a) {
      const info = roster[a.studentId];
      const y = info && info.year ? String(info.year) : String(a.studentId || "").substring(0, 2);
      return y.indexOf(filterYear) !== -1;
    });
  }

  // เรียงลำดับ: นำคนที่ทำล่าสุดขึ้นก่อน (Timeline ล่าสุดอยู่ด้านบน)
  filtered.sort(function (a, b) {
    return new Date(b.ts) - new Date(a.ts);
  });

  const headers = [
    "ลำดับ", "วันที่-เวลาทำล่าสุด", "รหัสประจำตัว", "ยศ-ชื่อ-สกุล", "ชั้นปี/รุ่น", "ระดับความเสี่ยง",
    "ST-5 (เครียด)", "2Q (คัดกรอง)", "9Q (ซึมเศร้า)", "8Q (ทำร้ายตนเอง)",
    "ดัชนีกล้อง AI", "สัญญาณขัดแย้ง", "เหตุผลการแปลผล", "สถานะติดตามงาน"
  ];

  const yearMapName = { "69": "ปี 1 (รุ่น 69)", "68": "ปี 2 (รุ่น 68)", "67": "ปี 3 (รุ่น 67)", "66": "ปี 4 (รุ่น 66)" };

  const rows = [headers];
  filtered.forEach(function (a, idx) {
    const info = roster[a.studentId];
    const al = alerts[a.studentId];
    const sIdStr = String(a.studentId || "").trim();
    const prefix = sIdStr.length >= 2 ? sIdStr.substring(0, 2) : "";
    const derivedYear = (info && info.year) ? info.year : (yearMapName[prefix] || (prefix ? ("รุ่น " + prefix) : "-"));

    rows.push([
      idx + 1,
      Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss"),
      '="' + sIdStr + '"', // ใส่ ="6903946" เพื่อให้ Excel ไม่ตัดเลข 0
      '"' + (info && info.name ? info.name : (a.name || "-")) + '"',
      '"' + derivedYear + '"',
      a.level,
      a.st5 !== null && a.st5 !== undefined && a.st5 !== "" ? a.st5 : "-",
      a.q2 !== null && a.q2 !== undefined && a.q2 !== "" ? a.q2 : "-",
      a.q9 !== null && a.q9 !== undefined && a.q9 !== "" ? a.q9 : "-",
      a.q8 !== null && a.q8 !== undefined && a.q8 !== "" ? a.q8 : "-",
      a.camIndex !== null && a.camIndex !== undefined && a.camIndex !== "" ? a.camIndex : "-",
      a.conflict ? "พบสัญญาณขัดแย้ง" : "ปกติ",
      '"' + String(a.reason || "").replace(/"/g, '""') + '"',
      al ? al.status : "-"
    ]);
  });

  // BOM สำหรับ Excel ภาษาไทย (\uFEFF)
  return "\uFEFF" + rows.map(function (r) { return r.join(","); }).join("\r\n");
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

  // สร้างงานติดตาม (Alerts) เมื่อไม่ใช่ GREEN
  let alertId = null;
  if (risk.level !== "GREEN") {
    alertId = createAlert(assessmentId, d, risk);
  }

  // 1. ส่งแจ้งเตือนอาจารย์ผ่าน Telegram ทุกครั้งที่มีการประเมิน
  notifyTeachers(alertId || "NORMAL", d, risk);

  // 2. ส่งสรุปผลประเมินส่วนตัว + คำแนะนำกลับไปยัง LINE ของนักเรียนคนนั้นทันที (ถ้ามี LINE userId)
  if (d.lineUserId) {
    notifyStudentLine(d, risk);
  }

  return { ok: true, assessmentId: assessmentId, riskLevel: risk.level, alertId: alertId };
}

/**
 * ส่งผลประเมินส่วนตัวและคำแนะนำการดูแลใจกลับไปยัง LINE ของนักเรียน
 */
function notifyStudentLine(d, risk) {
  if (!d.lineUserId) return;
  const token = getLineToken();
  if (!token) return;

  const icon = risk.level === "RED" ? "🔴" : (risk.level === "ORANGE" ? "🟠" : (risk.level === "YELLOW" ? "🟡" : "🟢"));
  const nameStr = d.displayName ? d.displayName : ("รหัส " + d.studentId);
  const apiUrl = ScriptApp.getService().getUrl();

  let advice = "";
  if (risk.level === "GREEN") {
    advice = "✨ ผลประเมินอยู่ในเกณฑ์ปกติ มีสุขภาวะทางใจที่ดี หมั่นพักผ่อนและดูแลสุขภาพอย่างสม่ำเสมอนะครับ";
  } else if (risk.level === "YELLOW") {
    advice = "🌿 ช่วงนี้อาจมีเรื่องตึงเครียดหรือเหนื่อยล้า แนะนำให้หาเวลาผ่อนคลาย หรือปรึกษาพูดคุยกับเพื่อน/อาจารย์ที่ปรึกษาได้เสมอนะครับ";
  } else if (risk.level === "ORANGE") {
    advice = "🧡 ระบบพบสัญญาณความเครียด/ความกังวลค่อนข้างสูง อาจารย์พร้อมรับฟังและให้คำปรึกษา แนะนำให้นัดหมายพูดคุยกับอาจารย์ที่ปรึกษานะครับ";
  } else if (risk.level === "RED") {
    advice = "🆘 ขอให้รู้ว่าน้องไม่ได้อยู่คนเดียว หากรู้สึกไม่ไหว โปรดติดต่ออาจารย์ผู้ดูแลทันที หรือสายด่วนสุขภาพจิต 1323 (โทรฟรี 24 ชม.)";
  }

  const text =
    "🌸 [สรุปผลการประเมินสุขภาพใจของน้อง]\n" +
    "ระบบดูแลใจ วิทยาลัยพยาบาลทหารอากาศ\n" +
    "------------------------------------\n" +
    "👤 นักเรียน: " + nameStr + " (" + d.studentId + ")\n" +
    "📊 ผลการประเมิน: " + icon + " " + risk.level + "\n" +
    "📝 รายละเอียดคะแนน:\n" +
    " • ST-5 (ความเครียด): " + (d.st5Score !== null ? d.st5Score : "-") + "/15\n" +
    " • 2Q (คัดกรอง): " + (d.q2Score !== null ? d.q2Score : "-") + "/2\n" +
    (d.q9Score !== null && d.q9Score !== undefined ? (" • 9Q (ซึมเศร้า): " + d.q9Score + "/27\n") : "") +
    (d.q8Score !== null && d.q8Score !== undefined ? (" • 8Q (ความเสี่ยง): " + d.q8Score + "/52\n") : "") +
    "------------------------------------\n" +
    advice + "\n\n" +
    "📥 ดาวน์โหลดเอกสารผลประเมินของน้อง:\n" +
    apiUrl + "?report=student&id=" + encodeURIComponent(d.studentId);

  pushLineFlexResult(token, d, risk);
}

/**
 * ส่งผลประเมินส่วนตัวในรูปแบบ LINE Flex Message (การ์ดสวยงาม ทันสมัย พร้อมปุ่มกดดาวน์โหลด)
 */
function pushLineFlexResult(token, d, risk) {
  if (!d.lineUserId || !token) return;

  const isRed = risk.level === "RED";
  const isOrange = risk.level === "ORANGE";
  const isYellow = risk.level === "YELLOW";
  
  const headerBg = isRed ? "#D32F2F" : (isOrange ? "#E65100" : (isYellow ? "#F57F17" : "#1B4332"));
  const riskTitle = isRed ? "🔴 ความเสี่ยงสูง (RED)" : (isOrange ? "🟠 ข้อบ่งชี้สำคัญ (ORANGE)" : (isYellow ? "🟡 ระดับเฝ้าระวัง (YELLOW)" : "🟢 สุขภาวะปกติ (GREEN)"));
  const nameStr = d.displayName ? d.displayName : ("รหัส " + d.studentId);
  const apiUrl = ScriptApp.getService().getUrl();
  const reportUrl = apiUrl + "?report=student&id=" + encodeURIComponent(d.studentId);
  const liffUrl = "https://liff.line.me/2010984231-Z7kbSIPp";

  let adviceText = "";
  if (isRed) {
    adviceText = "ขอให้น้องรู้ว่าไม่ได้อยู่คนเดียว หากรู้สึกไม่ไหว โปรดติดต่ออาจารย์ผู้ดูแลทันที หรือโทรสายด่วน 1323 (ฟรี 24 ชม.)";
  } else if (isOrange) {
    adviceText = "ระบบพบสัญญาณความเครียด/ความกังวลค่อนข้างสูง อาจารย์พร้อมรับฟังและให้คำปรึกษา แนะนำให้นัดหมายพูดคุยกับอาจารย์นะครับ";
  } else if (isYellow) {
    adviceText = "ช่วงนี้อาจมีเรื่องตึงเครียดหรือเหนื่อยล้า แนะนำให้หาเวลาพักผ่อน หรือชวนคุยกับเพื่อนและอาจารย์ที่ปรึกษาได้เสมอนะครับ";
  } else {
    adviceText = "ผลประเมินอยู่ในเกณฑ์ปกติ มีสุขภาวะทางใจที่ดี หมั่นพักผ่อนและดูแลสุขภาพกายใจอย่างสม่ำเสมอนะครับ ✨";
  }

  const flexPayload = {
    type: "flex",
    altText: "🌸 ผลการประเมินสุขภาพใจ: " + risk.level + " (" + d.studentId + ")",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: headerBg,
        paddingAll: "20px",
        contents: [
          { type: "text", text: "ระบบดูแลใจ วพอ.พอ.", color: "#FFFFFF", size: "xs", weight: "bold" },
          { type: "text", text: "สรุปผลการประเมินสุขภาพใจ", color: "#FFFFFF", size: "lg", weight: "bold", margin: "xs" },
          { type: "text", text: riskTitle, color: "#FFFFFF", size: "sm", margin: "sm", weight: "bold" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "รหัสนักเรียน", size: "xs", color: "#888888", flex: 2 },
              { type: "text", text: String(d.studentId), size: "xs", weight: "bold", color: "#333333", flex: 4 }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "ชื่อ-สกุล", size: "xs", color: "#888888", flex: 2 },
              { type: "text", text: nameStr, size: "xs", weight: "bold", color: "#333333", flex: 4 }
            ]
          },
          { type: "separator" },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "• ST-5 (ความเครียด)", size: "xs", color: "#555555", flex: 4 },
                  { type: "text", text: (d.st5Score !== null ? d.st5Score : "-") + "/15", size: "xs", weight: "bold", align: "end", flex: 2 }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "• 2Q (คัดกรองซึมเศร้า)", size: "xs", color: "#555555", flex: 4 },
                  { type: "text", text: (d.q2Score !== null ? d.q2Score : "-") + "/2", size: "xs", weight: "bold", align: "end", flex: 2 }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "• 9Q (ระดับซึมเศร้า)", size: "xs", color: "#555555", flex: 4 },
                  { type: "text", text: (d.q9Score !== null && d.q9Score !== undefined && d.q9Score !== "" ? d.q9Score : "-") + "/27", size: "xs", weight: "bold", align: "end", flex: 2 }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "• 8Q (เสี่ยงทำร้ายตนเอง)", size: "xs", color: "#555555", flex: 4 },
                  { type: "text", text: (d.q8Score !== null && d.q8Score !== undefined && d.q8Score !== "" ? d.q8Score : "-") + "/52", size: "xs", weight: "bold", align: "end", flex: 2 }
                ]
              }
            ]
          },
          { type: "separator" },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F8F9FA",
            cornerRadius: "md",
            paddingAll: "10px",
            contents: [
              { type: "text", text: "คำแนะนำการดูแลใจ:", size: "xxs", color: "#888888", weight: "bold" },
              { type: "text", text: adviceText, size: "xs", color: "#444444", wrap: true, margin: "xs" }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: headerBg,
            height: "sm",
            action: { type: "uri", label: "📥 ดาวน์โหลดเอกสารผลประเมิน", uri: reportUrl }
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "uri", label: "🌿 ทำแบบประเมินใหม่อีกครั้ง", uri: liffUrl }
          }
        ]
      }
    }
  };

  pushLineCustomMessage(token, d.lineUserId, flexPayload);
}

function pushLineCustomMessage(token, userId, messageObj) {
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ to: userId, messages: [messageObj] }),
      muteHttpExceptions: true,
    });
    return res.getResponseCode() === 200;
  } catch (err) {
    logError("pushLineCustomMessage", err, userId);
    return false;
  }
}

/**
 * ส่งผลประเมินย้อนหลังกลับไปยัง LINE ID ของนักเรียนทุกคนที่ผูกบัญชีไว้
 */
function pushResultsToAllStudentsLine(yearFilter) {
  const token = getLineToken();
  if (!token) return { ok: false, error: "ไม่พบ LINE_CHANNEL_ACCESS_TOKEN" };

  const data = loadAssessments();
  const roster = rosterMap();
  const bindSheet = getSheet(SHEETS.BINDINGS);
  const bRows = bindSheet.getDataRange().getValues();

  // สร้าง map: studentId -> lineUserId
  const studentLineMap = {};
  for (let i = 1; i < bRows.length; i++) {
    const lineId = String(bRows[i][0]).trim();
    const sId = String(bRows[i][1]).trim();
    if (lineId && sId) studentLineMap[sId] = lineId;
  }

  // หานักเรียนที่มีผลประเมินล่าสุด
  const latestAssessments = {};
  data.forEach(function (a) {
    if (!a.studentId) return;
    if (!latestAssessments[a.studentId] || new Date(a.ts) > new Date(latestAssessments[a.studentId].ts)) {
      latestAssessments[a.studentId] = a;
    }
  });

  let sentCount = 0;
  let skippedCount = 0;
  const targetYear = (yearFilter || "").trim();

  Object.keys(latestAssessments).forEach(function (sId) {
    if (targetYear && sId.indexOf(targetYear) !== 0) return;
    const lineUserId = studentLineMap[sId];
    if (!lineUserId) {
      skippedCount++;
      return;
    }

    const a = latestAssessments[sId];
    const info = roster[sId] || {};
    const d = {
      studentId: sId,
      displayName: info.name || a.name || "-",
      lineUserId: lineUserId,
      st5Score: a.st5,
      q2Score: a.q2,
      q9Score: a.q9,
      q8Score: a.q8
    };
    const risk = { level: a.level, reason: a.reason };

    try {
      notifyStudentLine(d, risk);
      sentCount++;
      Utilities.sleep(100); // เว้นระยะ 100ms เพื่อป้องกัน LINE API rate limit
    } catch (err) {
      logError("pushResultsToAllStudentsLine", err, sId);
    }
  });

  return {
    ok: true,
    message: "ส่งข้อมูลผลประเมินไปยัง LINE ของนักเรียนเรียบร้อยแล้ว",
    sentCount: sentCount,
    noLineBindingCount: skippedCount
  };
}

/**
 * ส่งผลประเมินส่วนตัวไปยัง LINE ID ของนักเรียนรายคน (ที่อาจารย์เลือก)
 */
function pushSingleStudentLine(studentId) {
  if (!studentId) return { ok: false, error: "กรุณาระบุรหัสนักเรียน" };
  const token = getLineToken();
  if (!token) return { ok: false, error: "ไม่พบ LINE_CHANNEL_ACCESS_TOKEN" };

  const roster = rosterMap();
  const bindSheet = getSheet(SHEETS.BINDINGS);
  const bRows = bindSheet.getDataRange().getValues();

  let lineUserId = null;
  for (let i = 1; i < bRows.length; i++) {
    if (String(bRows[i][1]).trim() === String(studentId).trim()) {
      lineUserId = String(bRows[i][0]).trim();
      break;
    }
  }

  // หากไม่มีในชีต Bindings ให้ตรวจใน Roster
  if (!lineUserId) {
    const rSheet = getSheet(SHEETS.ROSTER);
    const rRows = rSheet.getDataRange().getValues();
    const colIdx = rRows[0].indexOf("LINE userId") !== -1 ? rRows[0].indexOf("LINE userId") : 6;
    for (let j = 1; j < rRows.length; j++) {
      if (String(rRows[j][1]).trim() === String(studentId).trim() || String(rRows[j][0]).trim() === String(studentId).trim()) {
        lineUserId = String(rRows[j][colIdx] || "").trim();
        break;
      }
    }
  }

  if (!lineUserId) {
    return { ok: false, error: "นักเรียนรหัส " + studentId + " ยังไม่ได้ทำแบบประเมินผ่าน LINE หรือยังไม่ได้ผูก LINE ID" };
  }

  const logs = readTimelineLogs({ studentId: String(studentId).trim() });
  if (logs.length === 0) {
    return { ok: false, error: "ไม่พบประวัติผลประเมินของนักเรียนรหัส " + studentId };
  }

  const last = logs[0];
  const info = roster[studentId] || {};
  const d = {
    studentId: studentId,
    displayName: info.name || last.displayName || "-",
    lineUserId: lineUserId,
    st5Score: last.st5Score,
    q2Score: last.q2Score,
    q9Score: last.q9Score,
    q8Score: last.q8Score
  };
  const risk = { level: last.riskLevel, reason: last.reason };

  notifyStudentLine(d, risk);

  return {
    ok: true,
    message: "ส่งผลประเมินส่วนตัวให้นักเรียน " + (info.name || studentId) + " ทาง LINE เรียบร้อยแล้ว",
    studentId: studentId,
    displayName: info.name || "-",
    riskLevel: last.riskLevel
  };
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
 * ผูก/ค้นหารหัสนักเรียนจาก LINE userId พร้อมบันทึกประวัติการเข้าชม (Visitor Log) ทันทีทุกครั้ง
 * ชีต Bindings: lineUserId | studentId | boundAt
 */
function handleResolveStudent(d) {
  if (!d.lineUserId) throw new Error("missing lineUserId");
  const sh = getSheet(SHEETS.BINDINGS);
  const rows = sh.getDataRange().getValues();
  
  let foundStudentId = null;
  let rowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(d.lineUserId).trim()) {
      foundStudentId = rows[i][1];
      rowIndex = i + 1;
      break;
    }
  }

  // ถ้าเคยมีอยู่แล้ว -> อัปเดตเวลาที่เข้าใช้งานล่าสุด (Last Active)
  if (foundStudentId) {
    sh.getRange(rowIndex, 3).setValue(new Date());
    return { ok: true, studentId: foundStudentId };
  }

  // ถ้าเป็นผู้ใช้ LINE ใหม่ที่เพิ่งเข้าสู่ระบบ -> บันทึก LINE userId ทันที (ยังไม่ผูกรหัส)
  try {
    const currentRows = sh.getDataRange().getValues();
    let exists = false;
    for (let j = 1; j < currentRows.length; j++) {
      if (String(currentRows[j][0]).trim() === String(d.lineUserId).trim()) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      sh.appendRow([
        d.lineUserId,
        d.displayName ? ("LINE: " + d.displayName) : "VISITOR",
        new Date()
      ]);
    }
  } catch (e) {
    logError("handleResolveStudent.autoLog", e, d.lineUserId);
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

  const sh = getSheet(SHEETS.BINDINGS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    // LINE นี้เคยผูกไว้แล้ว → อัปเดตเป็นรหัสใหม่
    if (String(rows[i][0]).trim() === String(d.lineUserId).trim()) {
      sh.getRange(i + 1, 2).setValue(studentId);
      sh.getRange(i + 1, 3).setValue(new Date());
      return { ok: true, studentId: studentId, updated: true };
    }
  }
  // ผูกใหม่
  sh.appendRow([d.lineUserId, studentId, new Date()]);
  return { ok: true, studentId: studentId };
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

  // ซิงค์ LINE userId ลงในชีตทะเบียน (Roster) และชีต Bindings อัตโนมัติทันที
  if (d.lineUserId && d.studentId) {
    try {
      syncLineUserIdToRoster(String(d.studentId).trim(), String(d.lineUserId).trim());
    } catch (err) {
      logError("appendAssessment.syncRoster", err, d.studentId);
    }
  }
}

/**
 * บันทึก LINE userId ลงในชีต Roster (คอลัมน์ 7: LINE userId) และ Bindings
 */
function syncLineUserIdToRoster(studentId, lineUserId) {
  if (!studentId || !lineUserId) return;

  // 1. บันทึกลงชีต Roster
  const rosterSheet = getSheet(SHEETS.ROSTER);
  const rRows = rosterSheet.getDataRange().getValues();
  for (let i = 1; i < rRows.length; i++) {
    if (String(rRows[i][1]).trim() === studentId || String(rRows[i][0]).trim() === studentId) {
      // คอลัมน์ LINE userId ใน Roster คือคอลัมน์ 7 (G) หรือ 6 ขึ้นกับโครงสร้าง
      const colIndex = rRows[0].indexOf("LINE userId") !== -1 ? (rRows[0].indexOf("LINE userId") + 1) : 7;
      rosterSheet.getRange(i + 1, colIndex).setValue(lineUserId);
      break;
    }
  }

  // 2. บันทึกลงชีต Bindings (ป้องกันซ้ำ)
  const bindSheet = getSheet(SHEETS.BINDINGS);
  const bRows = bindSheet.getDataRange().getValues();
  let found = false;
  for (let j = 1; j < bRows.length; j++) {
    if (String(bRows[j][0]).trim() === lineUserId) {
      bindSheet.getRange(j + 1, 2).setValue(studentId);
      bindSheet.getRange(j + 1, 3).setValue(new Date());
      found = true;
      break;
    }
  }
  if (!found) {
    bindSheet.appendRow([lineUserId, studentId, new Date()]);
  }
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
  const isRed = risk.level === "RED";
  const isOrange = risk.level === "ORANGE";
  const isYellow = risk.level === "YELLOW";
  const icon = isRed ? "🔴" : (isOrange ? "🟠" : (isYellow ? "🟡" : "🟢"));
  const slaText = isRed ? "RED (พบแพทย์ทันที - SLA 1 ชั่วโมง)" : (isOrange ? "ORANGE (พบบุคลากรทางการแพทย์ - SLA 72 ชั่วโมง)" : (isYellow ? "YELLOW (เฝ้าระวัง/ชวนคุย)" : "GREEN (ปกติ)"));
  const nameStr = d.displayName ? d.displayName : ("รหัส " + d.studentId);
  const behScore = (d.behaviorIndex !== null && d.behaviorIndex !== undefined) ? d.behaviorIndex : "-";

  // ดึงสถิติความคืบหน้ารายชั้นปีแบบ Real-time
  const sId = String(d.studentId || "").trim();
  const yearPrefix = sId.length >= 2 ? sId.substring(0, 2) : "";
  const yearNames = { "69": "ชั้นปีที่ 1 (รุ่น 69)", "68": "ชั้นปีที่ 2 (รุ่น 68)", "67": "ชั้นปีที่ 3 (รุ่น 67)", "66": "ชั้นปีที่ 4 (รุ่น 66)" };
  const yearStat = yearPrefix ? checkMissingStudents(yearPrefix) : null;
  const yearLabel = yearNames[yearPrefix] || (yearPrefix ? ("รุ่น " + yearPrefix) : "ไม่ระบุชั้นปี");

  // แปลผลคะแนนแต่ละชุด
  const st5Score = (d.st5Score !== null && d.st5Score !== undefined && d.st5Score !== "") ? Number(d.st5Score) : "-";
  const q2Score = (d.q2Score !== null && d.q2Score !== undefined && d.q2Score !== "") ? Number(d.q2Score) : "-";
  const q9Score = (d.q9Score !== null && d.q9Score !== undefined && d.q9Score !== "") ? Number(d.q9Score) : null;
  const q8Score = (d.q8Score !== null && d.q8Score !== undefined && d.q8Score !== "") ? Number(d.q8Score) : null;

  const st5Level = typeof st5Score === "number" ? (st5Score >= 10 ? " (ระดับสูง)" : (st5Score >= 8 ? " (ปานกลาง)" : " (ปกติ)")) : "";
  const q2Level = typeof q2Score === "number" ? (q2Score >= 1 ? " (พบข้อบ่งชี้)" : " (ปกติ)") : "";
  const q9Level = q9Score !== null ? (q9Score >= 19 ? " (ระดับรุนแรงมาก)" : (q9Score >= 13 ? " (ระดับรุนแรง)" : (q9Score >= 7 ? " (ปานกลาง)" : " (ปกติ)"))) : "";
  const q8Level = q8Score !== null ? (q8Score >= 17 ? " (ระดับรุนแรงมาก)" : (q8Score >= 9 ? " (ปานกลาง)" : " (เล็กน้อย)")) : "";

  // สัญญาณพฤติกรรมใบหน้า AI
  let aiSignals = "";
  if (d.cameraUsed) {
    aiSignals =
      "📷 ดัชนีพฤติกรรม (กล้อง AI): " + behScore + "/100\n" +
      "⚠️ สัญญาณที่ระบบพบ:\n" +
      " • คิ้วขมวดสะสม (AU4 Burst): " + (d.behaviorFlags && d.behaviorFlags.au4High ? "พบความตึงเครียดสูง" : "ปกติ") + "\n" +
      " • การแสดงออกทางอารมณ์: " + (d.behaviorFlags && d.behaviorFlags.flatAffect ? "ไม่มีรอยยิ้มตลอดการทำ (Flat Affect)" : "ปกติ") + "\n" +
      " • อัตราการกะพริบตา: " + (d.behaviorFlags && d.behaviorFlags.eyeFatigue ? "พบลักษณะอ่อนล้า" : "ปกติ") + "\n";
  } else {
    aiSignals = "📷 ดัชนีพฤติกรรม (กล้อง AI): ไม่ได้เปิดกล้อง\n";
  }

  // สร้างข้อความแจ้งเตือน + อัปเดตความคืบหน้ารายชั้นปี
  let text =
    icon + " [แจ้งเตือนด่วนดัชนีเฝ้าระวังล่าสุด]\n" +
    "ระบบดูแลใจ วพอ.พอ.\n" +
    "------------------------------------\n" +
    "👤 นักเรียน: " + nameStr + " (" + d.studentId + ")\n" +
    "🎓 ชั้นปี: " + yearLabel + "\n" +
    "📊 ระดับความเสี่ยง: " + icon + " " + slaText + "\n" +
    "📝 รายละเอียดผลประเมิน:\n" +
    " • ST-5 (ความเครียด): " + st5Score + "/15 คะแนน" + st5Level + "\n" +
    " • 2Q (คัดกรองซึมเศร้า): " + q2Score + "/2 คะแนน" + q2Level + "\n";

  if (q9Score !== null) {
    text += " • 9Q (ประเมินซึมเศร้า): " + q9Score + "/27 คะแนน" + q9Level + "\n";
  }
  if (q8Score !== null) {
    text += " • 8Q (เสี่ยงทำร้ายตนเอง): " + q8Score + "/52 คะแนน" + q8Level + "\n";
  }

  text += aiSignals +
    (d.conflictFlag ? "⚠️ สัญญาณขัดแย้ง: ตอบปกติแต่พฤติกรรมกล้องบ่งชี้ความตึงเครียด\n" : "") +
    "------------------------------------\n";

  // ส่วนอัปเดตสถิติยอดทำของชั้นปี
  if (yearStat) {
    text += "📈 ความคืบหน้า " + yearLabel + ":\n" +
      " • ทำแล้ว: " + yearStat.submittedCount + (yearStat.expectedTotal ? ("/" + yearStat.expectedTotal) : "") + " คน\n" +
      " • คงเหลือที่ยังไม่ทำ: " + yearStat.missingCount + " คน\n" +
      "------------------------------------\n";
  }

  text += "🏥 สถานที่ส่งต่อ: รพ.ภูมิพลอดุลยเดช พอ. / รพ.กองบิน\n" +
    "🆔 รหัสงาน (Alert ID): " + alertId + "\n" +
    "📁 บันทึกข้อมูลลง Excel/Google Sheet เรียบร้อยแล้ว";

  // สร้างปุ่มกด Interactive ใน Telegram (Inline Keyboard)
  const webAppUrl = "https://anuchit1tube168-cmd.github.io/mindcare/";
  const sheetUrl = "https://docs.google.com/spreadsheets/d/1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ/edit";
  const apiUrl = ScriptApp.getService().getUrl();

  const telegramButtons = {
    inline_keyboard: [
      [
        { text: "👤 📥 โหลดรายงานประวัติรายคน (" + d.studentId + ")", url: apiUrl + "?report=student&id=" + encodeURIComponent(d.studentId) }
      ],
      [
        { text: "📊 เปิด Google Sheet", url: sheetUrl },
        { text: "🌐 เปิดระบบดูแลใจ", url: webAppUrl }
      ],
      [
        { text: "📑 โหลด Log ย้อนหลัง 7 วัน", url: apiUrl + "?report=downloadReport&days=7" },
        { text: "🔴 โหลดเคส RED ล่าสุด", url: apiUrl + "?report=downloadReport&level=RED" }
      ]
    ]
  };

  // ส่งแจ้งเตือนหลัก
  let telegramSent = false;
  // ถ้ามีภาพถ่ายใบหน้าขณะประเมิน -> ส่งภาพพร้อมแคปชันละเอียด + ปุ่มกดเข้า Telegram
  if (d.faceSnapshot && String(d.faceSnapshot).indexOf("data:image") === 0) {
    try {
      const base64Data = String(d.faceSnapshot).split(",")[1];
      const bytes = Utilities.base64Decode(base64Data);
      const photoBlob = Utilities.newBlob(bytes, "image/jpeg", "snapshot_" + d.studentId + ".jpg");
      telegramSent = pushTelegramPhoto(photoBlob, text, telegramButtons);
    } catch (err) {
      logError("notifyTeachers.photo", err, alertId);
    }
  }

  // ถ้าไม่ได้ส่งผ่านรูป (หรือส่งรูปไม่สำเร็จ) -> ส่งเป็นข้อความตัวหนังสือพร้อมปุ่มกด
  if (!telegramSent) {
    telegramSent = pushTelegramMessage(text, telegramButtons);
  }

  // ส่ง LINE (ถ้ามีโควตา)
  sendAlertLineOnly(text, risk.level);
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
function pushTelegramMessage(text, replyMarkup) {
  const props = PropertiesService.getScriptProperties();
  const botToken = props.getProperty("TELEGRAM_BOT_TOKEN") || "8420567411:AAE1TRV1hipd_HysrNtgi3QxxXOo16wSt70";
  const chatId = props.getProperty("TELEGRAM_CHAT_ID") || "-5442365939";
  if (!botToken || !chatId) return false;

  try {
    const payload = {
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
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
function pushTelegramPhoto(photoBlob, caption, replyMarkup) {
  const props = PropertiesService.getScriptProperties();
  const botToken = props.getProperty("TELEGRAM_BOT_TOKEN") || "8420567411:AAE1TRV1hipd_HysrNtgi3QxxXOo16wSt70";
  const chatId = props.getProperty("TELEGRAM_CHAT_ID") || "-5442365939";
  if (!botToken || !chatId || !photoBlob) return false;

  try {
    const payload = {
      chat_id: chatId,
      photo: photoBlob,
      caption: caption || "",
    };
    if (replyMarkup) {
      payload.reply_markup = JSON.stringify(replyMarkup);
    }
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
