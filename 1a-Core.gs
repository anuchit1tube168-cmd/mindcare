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
    const postBody = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const data = JSON.parse(postBody);

    // ---- 1. รับข้อความและคำสั่งจาก Telegram Webhook (พิมพ์คำสั่งในกลุ่มแล้วบอทตอบทันที) ----
    if (data.message || data.callback_query) {
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
    const msg = update.message || (update.callback_query && update.callback_query.message);
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = String(msg.text || (update.callback_query && update.callback_query.data) || "").trim();

    if (!text) return;

    const lower = text.toLowerCase();
    const apiUrl = ScriptApp.getService().getUrl();
    const sheetUrl = "https://docs.google.com/spreadsheets/d/1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ/edit";

    // 1. คำสั่งตรวจสอบรายชื่อคนที่ยังไม่ทำ (/missing, /check, "ขาด", "ยังไม่ทำ", "เช็ค")
    if (lower.indexOf("/missing") === 0 || lower.indexOf("/check") === 0 || lower.indexOf("ขาด") !== -1 || lower.indexOf("ยังไม่ทำ") !== -1 || lower.indexOf("เช็ค") !== -1) {
      let targetYear = "";
      if (text.indexOf("1") !== -1 || text.indexOf("69") !== -1) targetYear = "69";
      else if (text.indexOf("2") !== -1 || text.indexOf("68") !== -1) targetYear = "68";
      else if (text.indexOf("3") !== -1 || text.indexOf("67") !== -1) targetYear = "67";
      else if (text.indexOf("4") !== -1 || text.indexOf("66") !== -1) targetYear = "66";

      const missingResult = checkMissingStudents(targetYear);
      
      let reply = "📋 [ตรวจสอบสถานะการทำแบบประเมิน วพอ.พอ.]\n" +
        "------------------------------------\n" +
        "• ประเมินแล้ว: " + missingResult.submittedCount + " คน\n" +
        "• ยังไม่ทำ: " + missingResult.missingCount + " คน\n" +
        "------------------------------------\n";

      if (missingResult.missingList.length > 0) {
        reply += "⚠️ รายชื่อผู้ที่ยังไม่ทำ" + (targetYear ? (" (รุ่น " + targetYear + ")") : "") + ":\n";
        missingResult.missingList.slice(0, 20).forEach(function(s, idx) {
          reply += (idx + 1) + ". " + s.id + " " + s.name + " (" + s.year + ")\n";
        });
        if (missingResult.missingList.length > 20) {
          reply += "... และอีก " + (missingResult.missingList.length - 20) + " คน (ดูทั้งหมดในตาราง)\n";
        }
      } else {
        reply += "🎉 ยอดเยี่ยมมาก! ทุกคนทำแบบประเมินครบถ้วน 100% แล้วครับ";
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

    // 2. คำสั่งดึงข้อมูลรายงานผลแยกรายชั้นปี (เช่น "ปี 1", "ปี 2", "ปี 3", "ปี 4", "/year1", "/year", "รายงานปี")
    if (lower.indexOf("/year") === 0 || lower.indexOf("รายงานปี") !== -1 || (lower.indexOf("ปี") !== -1 && (text.indexOf("1") !== -1 || text.indexOf("2") !== -1 || text.indexOf("3") !== -1 || text.indexOf("4") !== -1))) {
      let targetYear = "69";
      let yearName = "ชั้นปีที่ 1 (รุ่น 69)";
      if (text.indexOf("2") !== -1 || text.indexOf("68") !== -1) { targetYear = "68"; yearName = "ชั้นปีที่ 2 (รุ่น 68)"; }
      else if (text.indexOf("3") !== -1 || text.indexOf("67") !== -1) { targetYear = "67"; yearName = "ชั้นปีที่ 3 (รุ่น 67)"; }
      else if (text.indexOf("4") !== -1 || text.indexOf("66") !== -1) { targetYear = "66"; yearName = "ชั้นปีที่ 4 (รุ่น 66)"; }

      const logs = readTimelineLogs({ year: targetYear });
      const distinctStudents = {};
      logs.forEach(function(l) { distinctStudents[l.studentId] = l; });
      const studentCount = Object.keys(distinctStudents).length;

      let yReply = "📑 [รายงานผลประเมินสุขภาพใจ: " + yearName + "]\n" +
        "------------------------------------\n" +
        "• จำนวนนักเรียนที่ประเมินแล้ว: " + studentCount + " คน (" + logs.length + " ครั้ง)\n" +
        "------------------------------------\n";

      if (logs.length > 0) {
        yReply += "📋 รายชื่อและผลประเมินล่าสุด (ตัวอย่าง):\n";
        Object.values(distinctStudents).slice(0, 15).forEach(function(s, idx) {
          const riskIcon = s.riskLevel === "RED" ? "🔴" : (s.riskLevel === "ORANGE" ? "🟠" : (s.riskLevel === "YELLOW" ? "🟡" : "🟢"));
          yReply += (idx + 1) + ". " + s.studentId + " " + s.displayName + " ➔ " + riskIcon + " " + s.riskLevel + " (ST5:" + s.st5Score + " 9Q:" + (s.q9Score || 0) + " 8Q:" + (s.q8Score || 0) + ")\n";
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
            { text: "⚠️ ดูรายชื่อที่ยังไม่ทำ (" + yearName + ")", url: apiUrl + "?report=missing&year=" + targetYear }
          ],
          [
            { text: "📊 เปิด Google Sheet", url: sheetUrl }
          ]
        ]
      };

      pushTelegramMessage(yReply, yButtons);
      return;
    }

    // 3. คำสั่งสรุปภาพรวม (/summary, "สรุป", "ภาพรวม")
    if (lower.indexOf("/summary") === 0 || lower.indexOf("สรุป") !== -1 || lower.indexOf("ภาพรวม") !== -1) {
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

    // 3. ถ้าพิมพ์รหัสนักเรียน 7 หลักมาตรงๆ -> ดึงประวัติรายคนส่งกลับให้ทันที
    if (/^\d{7}$/.test(text)) {
      const studentId = text;
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
            { text: "📥 โหลดไฟล์รายงานรายคน (CSV)", url: apiUrl + "?report=student&id=" + studentId }
          ],
          [
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
 */
function checkMissingStudents(yearFilter) {
  const rosterSheet = getSheet(SHEETS.ROSTER);
  const rRows = rosterSheet.getDataRange().getValues();
  const data = loadAssessments();

  const submittedSet = {};
  data.forEach(function (a) {
    if (a.studentId) submittedSet[String(a.studentId).trim()] = true;
  });

  const missingList = [];
  let submittedCount = 0;

  for (let i = 1; i < rRows.length; i++) {
    const sId = String(rRows[i][1] || rRows[i][0]).trim();
    const name = rRows[i][2] || rRows[i][1] || "";
    const year = rRows[i][3] || rRows[i][2] || "";

    if (!sId || !/^\d{7}$/.test(sId)) continue;
    if (yearFilter && sId.indexOf(yearFilter) !== 0 && String(year).indexOf(yearFilter) === -1) continue;

    if (submittedSet[sId]) {
      submittedCount++;
    } else {
      missingList.push({ id: sId, name: name, year: year });
    }
  }

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
      rows.push([idx + 1, s.id, '"' + s.name + '"', s.year || "-", "ยังไม่ทำแบบประเมิน"]);
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

  // 4. ขอไฟล์เอกสารรายงาน Excel (.xlsx) ที่จัดเก็บใน Google Drive
  if (action === "exportDrive" || action === "getReportUrl") {
    const res = exportReportNow(Number(p.days || 7));
    return output(res);
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
 */
function generateReportCsv(filterLevel, filterYear, filterDays) {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();
  const now = new Date();
  const since = filterDays ? new Date(now.getTime() - filterDays * 86400 * 1000) : null;

  let filtered = data;
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

  // เรียงลำดับ: Timeline วันที่ล่าสุดก่อน (หากระดับต่างกันให้แสดงระดับรุนแรงก่อน)
  filtered.sort(function (a, b) {
    const d = riskRank(b.level) - riskRank(a.level);
    return d !== 0 ? d : new Date(b.ts) - new Date(a.ts);
  });

  const headers = [
    "ระดับความเสี่ยง", "รหัสประจำตัว", "ชื่อ-สกุล", "ชั้นปี/รุ่น", "วันเวลาประเมิน",
    "ST-5 (เครียด)", "2Q (คัดกรอง)", "9Q (ซึมเศร้า)", "8Q (ทำร้ายตนเอง)",
    "ดัชนีกล้อง AI", "สัญญาณขัดแย้ง", "เหตุผลความเสี่ยง", "สถานะติดตามงาน"
  ];

  const rows = [headers];
  filtered.forEach(function (a) {
    const info = roster[a.studentId];
    const al = alerts[a.studentId];
    rows.push([
      a.level,
      a.studentId,
      info && info.name ? info.name : (a.name || "-"),
      info && info.year ? info.year : "-",
      Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss"),
      a.st5 !== null && a.st5 !== undefined ? a.st5 : "-",
      a.q2 !== null && a.q2 !== undefined ? a.q2 : "-",
      a.q9 !== null && a.q9 !== undefined ? a.q9 : "-",
      a.q8 !== null && a.q8 !== undefined ? a.q8 : "-",
      a.camIndex !== null && a.camIndex !== undefined ? a.camIndex : "-",
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

  // ส่งแจ้งเตือน Telegram ทุกครั้งที่มีการประเมิน
  notifyTeachers(alertId || "NORMAL", d, risk);

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

  // ซิงค์ LINE userId ลงในชีตทะเบียน (Roster) และชีต Bindings อัตโนมัติทันที
  if (d.lineUserId && d.studentId && /^\d{7}$/.test(String(d.studentId).trim())) {
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
  const icon = isRed ? "🔴" : (isOrange ? "🟠" : "🟡");
  const slaText = isRed ? "RED (พบแพทย์ทันที - SLA 1 ชั่วโมง)" : (isOrange ? "ORANGE (พบบุคลากรทางการแพทย์ - SLA 24 ชั่วโมง)" : "YELLOW (เฝ้าระวัง/พูดคุย)");
  const nameStr = d.displayName ? d.displayName : ("รหัส " + d.studentId);
  const behScore = (d.behaviorIndex !== null && d.behaviorIndex !== undefined) ? d.behaviorIndex : "-";

  // แปลผลคะแนนแต่ละชุด
  const st5Level = d.st5Score >= 10 ? " (ระดับสูง)" : (d.st5Score >= 8 ? " (ปานกลาง)" : " (ปกติ)");
  const q2Level = d.q2Score >= 1 ? " (พบข้อบ่งชี้)" : " (ปกติ)";
  const q9Level = d.q9Score >= 19 ? " (ระดับรุนแรงมาก)" : (d.q9Score >= 13 ? " (ระดับรุนแรง)" : (d.q9Score >= 7 ? " (ปานกลาง)" : " (ปกติ)"));
  const q8Level = d.q8Score >= 17 ? " (ระดับรุนแรงมาก)" : (d.q8Score >= 9 ? " (ปานกลาง)" : " (เล็กน้อย)");

  // สัญญาณพฤติกรรมใบหน้า AI
  let aiSignals = "";
  if (d.cameraUsed) {
    aiSignals =
      "📷 ดัชนีพฤติกรรม (กล้อง AI): " + behScore + "/100\n" +
      "⚠️ สัญญาณที่ระบบพบ:\n" +
      " - คิ้วขมวดสะสม (AU4 Burst): " + (d.behaviorFlags && d.behaviorFlags.au4High ? "พบความตึงเครียดสูง" : "ปกติ") + "\n" +
      " - การแสดงออกทางอารมณ์: " + (d.behaviorFlags && d.behaviorFlags.flatAffect ? "ไม่มีรอยยิ้มตลอดการทำ (Flat Affect)" : "ปกติ") + "\n" +
      " - อัตราการกะพริบตา/การละสายตา: " + (d.behaviorFlags && d.behaviorFlags.eyeFatigue ? "พบลักษณะอ่อนล้า" : "ปกติ") + "\n";
  } else {
    aiSignals = "📷 ดัชนีพฤติกรรม (กล้อง AI): ไม่ได้เปิดกล้อง\n";
  }

  const text =
    icon + " [แจ้งเตือนด่วนดัชนีเฝ้าระวังล่าสุด]\n" +
    "ระบบดูแลใจ วพอ.พอ.\n" +
    "------------------------------------\n" +
    "👤 รหัสนักเรียน/ชื่อ: " + d.studentId + " (" + nameStr + ")\n" +
    "📊 ระดับความเสี่ยง: " + icon + " " + slaText + "\n" +
    "📝 รายละเอียดผลประเมิน:\n" +
    " • ST-5 (ความเครียด): " + (d.st5Score !== null ? d.st5Score : "-") + "/15 คะแนน" + st5Level + "\n" +
    " • 2Q (คัดกรองซึมเศร้า): " + (d.q2Score !== null ? d.q2Score : "-") + "/2 คะแนน" + q2Level + "\n" +
    " • 9Q (ประเมินซึมเศร้า): " + (d.q9Score !== null ? d.q9Score : "-") + "/27 คะแนน" + q9Level + "\n" +
    " • 8Q (เสี่ยงทำร้ายตนเอง): " + (d.q8Score !== null ? d.q8Score : "-") + "/52 คะแนน" + q8Level + "\n" +
    aiSignals +
    (d.conflictFlag ? "⚠️ สัญญาณขัดแย้ง: ตอบปกติแต่พฤติกรรมกล้องบ่งชี้ความตึงเครียด\n" : "") +
    "------------------------------------\n" +
    "🏥 สถานที่ส่งต่อ: รพ.ภูมิพลอดุลยเดช พอ. / รพ.กองบิน\n" +
    "🆔 รหัสงาน (Alert ID): " + alertId + "\n" +
    "📁 บันทึกข้อมูลลง Excel/Google Sheet เรียบร้อยแล้ว\n" +
    "👉 โปรดเปิด Dashboard เพื่อรับเรื่องและประสานการดูแล";

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
