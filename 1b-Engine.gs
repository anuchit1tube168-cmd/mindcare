/* ==========================================================
 * Escalation: ตรวจงานค้างเกิน SLA (ตั้ง time-driven trigger รายชั่วโมง)
 * ตั้งค่า: Triggers → checkOverdueAlerts → Time-driven → Hour timer
 * ========================================================== */

function checkOverdueAlerts() {
  const sh = getSheet(SHEETS.ALERTS);
  const rows = sh.getDataRange().getValues();
  const now = new Date();
  const updates = []; // เก็บไว้เขียนทีเดียว ลดจำนวนครั้งที่แตะชีต

  for (let i = 1; i < rows.length; i++) {
    const status = rows[i][6];
    const due = rows[i][7];
    const escalations = Number(rows[i][11] || 0);
    const level = rows[i][4];

    const stillOpen = status === "แจ้งแล้ว" || status === "รับเรื่องแล้ว";
    if (!stillOpen || !(due instanceof Date) || now < due || escalations >= 3) continue;

    const text =
      "⏰ [เตือนซ้ำ ครั้งที่ " + (escalations + 1) + "] งานเกินกำหนด\n" +
      "รหัสงาน: " + rows[i][1] + "\n" +
      "รหัสนักเรียน: " + rows[i][3] + "\n" +
      "ระดับ: " + level + " สถานะปัจจุบัน: " + status + "\n" +
      "โปรดติดต่อนักเรียนและอัปเดตสถานะโดยเร็ว";

    // เตือนซ้ำใช้ระดับของเคสจริง เพื่อให้เคสแดงยังได้ LINE แม้โควตาเหลือน้อย
    sendAlert(text, level === "RED" ? "RED" : "REPORT");
    updates.push({ row: i + 1, escalations: escalations + 1 });
  }

  updates.forEach(function (u) {
    sh.getRange(u.row, 12).setValue(u.escalations);
  });
}

/* ==========================================================
 * สรุปข้อมูลสำหรับ dashboard (เฟสถัดไปจะขยาย)
 * ========================================================== */

function getSummary() {
  const sh = getSheet(SHEETS.ALERTS);
  const rows = sh.getDataRange().getValues();
  const open = { RED: 0, ORANGE: 0, YELLOW: 0 };
  for (let i = 1; i < rows.length; i++) {
    const status = rows[i][6];
    const level = rows[i][4];
    if ((status === "แจ้งแล้ว" || status === "รับเรื่องแล้ว") && open[level] !== undefined) {
      open[level]++;
    }
  }
  return { ok: true, openAlerts: open, updatedAt: new Date().toISOString() };
}

/* ==========================================================
 * รายงานเฝ้าระวังรายสัปดาห์
 * ตั้ง time-driven trigger: weeklyWatchReport → Week timer (เช่น จันทร์ 08:00)
 * สรุปข้อมูล 7 วันล่าสุด + สถานะงานค้าง แล้วบันทึกลงชีต Reports
 * และ push สรุปให้อาจารย์ (ตัวเลขรวม ไม่ระบุรายบุคคล)
 * ========================================================== */

function weeklyWatchReport() {
  const report = buildWatchReport(7);
  // บันทึกประวัติรายงาน
  getSheet(SHEETS.REPORTS).appendRow([
    new Date(), report.periodDays,
    report.total, report.byRisk.RED, report.byRisk.ORANGE,
    report.byRisk.YELLOW, report.byRisk.GREEN,
    report.cameraConflicts, report.openAlerts, report.overdue,
    sanitize(JSON.stringify(report.byStudentYear || {})),
  ]);

  // push สรุปให้อาจารย์
  const summaryText =
    "📊 รายงานเฝ้าระวังสุขภาพใจ (7 วันล่าสุด)\n" +
    "ระบบดูแลใจ วพอ.พอ.\n" +
    "— แบบประเมินทั้งหมด: " + report.total + " ครั้ง\n" +
    "🔴 เสี่ยงสูงสุด: " + report.byRisk.RED + "\n" +
    "🟠 สำคัญ: " + report.byRisk.ORANGE + "\n" +
    "🟡 ควรชวนคุย: " + report.byRisk.YELLOW + "\n" +
    "📷 สัญญาณขัดแย้งจากกล้อง: " + report.cameraConflicts + "\n" +
    "⏳ งานค้างทั้งหมด: " + report.openAlerts +
    " (เกินกำหนด " + report.overdue + ")\n" +
    "โปรดเปิด dashboard เพื่อดูรายละเอียดและติดตามเคส";

  // รายงานเป็นข้อมูลไม่ฉุกเฉิน จึงยอมงดทาง LINE ก่อนถ้าโควตาใกล้หมด
  sendAlert(summaryText, "REPORT");

  // export ไฟล์รายงานเข้า Google Drive folder ที่กำหนด
  try {
    exportReportToDrive(report);
  } catch (err) {
    logError("weeklyWatchReport.export", err, "");
  }
  return report;
}

/**
 * สร้างไฟล์รายงาน Excel (.xlsx) แยกประเภท/ชั้นปี/เพศ แล้วบันทึกลง Drive folder
 * วิธี: สร้าง Google Sheet ชั่วคราวในโฟลเดอร์ จัดข้อมูลเป็นตารางแยกประเภท
 * แล้วแปลงเป็น .xlsx ผ่าน Drive API export ก่อนลบ Sheet ต้นฉบับทิ้ง
 * (GAS สร้าง .xlsx ตรงไม่ได้ ต้องผ่าน Google Sheet เป็นตัวกลาง)
 */
function exportReportToDrive(report) {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const now = new Date();
  const stamp = Utilities.formatDate(now, "Asia/Bangkok", "yyyy-MM-dd_HHmm");
  const title = "รายงานเฝ้าระวัง_" + stamp;

  // สร้าง Google Sheet ชั่วคราว
  const ss = SpreadsheetApp.create(title);
  const sheet = ss.getSheets()[0];
  sheet.setName("รายงานแยกประเภท");

  const byYear = report.byStudentYear || {};
  const rows = [];
  rows.push(["รายงานเฝ้าระวังสุขภาพใจ ระบบดูแลใจ วพอ.พอ.", "", "", ""]);
  rows.push(["สร้างเมื่อ", Utilities.formatDate(now, "Asia/Bangkok", "dd/MM/yyyy HH:mm"),
             "ช่วงข้อมูล(วัน)", report.periodDays]);
  rows.push(["", "", "", ""]);
  rows.push(["๑) แยกตามระดับความเสี่ยง", "", "", ""]);
  rows.push(["ระดับ", "จำนวน (ครั้ง)", "", ""]);
  rows.push(["RED (เสี่ยงสูงสุด)", report.byRisk.RED, "", ""]);
  rows.push(["ORANGE (สำคัญ)", report.byRisk.ORANGE, "", ""]);
  rows.push(["YELLOW (ควรชวนคุย)", report.byRisk.YELLOW, "", ""]);
  rows.push(["GREEN (ปกติ)", report.byRisk.GREEN, "", ""]);
  rows.push(["รวมทั้งหมด", report.total, "", ""]);
  rows.push(["", "", "", ""]);
  rows.push(["๒) แยกตามชั้นปี", "ประเมินทั้งหมด", "ต้องดูแล(แดง+ส้ม+เหลือง)", ""]);
  Object.keys(byYear).sort().forEach(function (y) {
    rows.push([y, byYear[y].total, byYear[y].atRisk, ""]);
  });
  rows.push(["", "", "", ""]);
  rows.push(["๓) สัญญาณจากกล้อง", "", "", ""]);
  rows.push(["สัญญาณขัดแย้ง (ตอบปกติแต่ดัชนีสูง)", report.cameraConflicts, "", ""]);
  rows.push(["", "", "", ""]);
  rows.push(["๔) งานติดตาม", "", "", ""]);
  rows.push(["งานค้างทั้งหมด", report.openAlerts, "เกินกำหนด", report.overdue]);

  sheet.getRange(1, 1, rows.length, 4).setValues(rows);
  // จัดรูปแบบหัวตาราง
  sheet.getRange(1, 1, 1, 4).merge().setFontWeight("bold").setFontSize(13);
  [4, 12, 15, 18].forEach(function (r) {
    sheet.getRange(r, 1, 1, 4).setFontWeight("bold").setBackground("#1B4332").setFontColor("#FFFFFF");
  });
  sheet.setColumnWidth(1, 260); sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(3, 200); sheet.setColumnWidth(4, 120);
  SpreadsheetApp.flush();

  // แปลงเป็น .xlsx ผ่าน Drive export URL
  const ssId = ss.getId();
  const url = "https://docs.google.com/spreadsheets/d/" + ssId + "/export?format=xlsx";
  const token = ScriptApp.getOAuthToken();
  const resp = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token } });
  const xlsxBlob = resp.getBlob().setName(title + ".xlsx");
  const file = folder.createFile(xlsxBlob);

  // ลบ Google Sheet ต้นฉบับทิ้ง เหลือแต่ .xlsx ในโฟลเดอร์
  DriveApp.getFileById(ssId).setTrashed(true);
  return file.getUrl();
}

/** สั่ง export ทันทีตามช่วงเวลาที่ต้องการ (เรียกจาก dashboard ได้ ต้องมี token) */
function exportReportNow(days) {
  const report = buildWatchReport(days || 7);
  const url = exportReportToDrive(report);
  return { ok: true, fileUrl: url, report: report };
}

/**
 * สร้างสรุปข้อมูลย้อนหลัง N วัน — ใช้ได้ทั้งรายงานอัตโนมัติและ dashboard
 * แยกตามชั้นปีจากรหัสนักเรียน (สมมติ 2 ตัวแรกของรหัส = รุ่น/ชั้นปี;
 * ปรับ logic getYear ให้ตรงรูปแบบรหัสจริงของ วพอ.พอ.)
 */
function buildWatchReport(days) {
  const since = new Date(Date.now() - days * 86400 * 1000);
  const aRows = getSheet(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const byRisk = { RED: 0, ORANGE: 0, YELLOW: 0, GREEN: 0 };
  const byStudentYear = {};
  let total = 0, cameraConflicts = 0;

  for (let i = 1; i < aRows.length; i++) {
    const ts = aRows[i][0];
    if (!(ts instanceof Date) || ts < since) continue;
    total++;
    const level = aRows[i][13];
    if (byRisk[level] !== undefined) byRisk[level]++;
    if (aRows[i][11] === true) cameraConflicts++;   // conflictFlag
    const year = getStudentYear(String(aRows[i][2]));
    if (!byStudentYear[year]) byStudentYear[year] = { total: 0, atRisk: 0 };
    byStudentYear[year].total++;
    if (level === "RED" || level === "ORANGE" || level === "YELLOW") byStudentYear[year].atRisk++;
  }

  // นับงานค้าง + เกินกำหนดจากชีต Alerts
  const alertRows = getSheet(SHEETS.ALERTS).getDataRange().getValues();
  let openAlerts = 0, overdue = 0;
  const now = new Date();
  for (let i = 1; i < alertRows.length; i++) {
    const status = alertRows[i][6];
    if (status === "แจ้งแล้ว" || status === "รับเรื่องแล้ว") {
      openAlerts++;
      const due = alertRows[i][7];
      if (due instanceof Date && now > due) overdue++;
    }
  }

  return { periodDays: days, total, byRisk, cameraConflicts, byStudentYear, openAlerts, overdue };
}

/** ดึงชั้นปี/รุ่นจากรหัสนักเรียน — ปรับให้ตรงรูปแบบรหัสจริง */
function getStudentYear(studentId) {
  if (!studentId || studentId.length < 2) return "ไม่ระบุ";
  return studentId.substring(0, 2); // สมมติ 2 ตัวแรก = รุ่น
}

/* endpoint สำหรับ dashboard เรียกดูรายงานตามช่วงเวลา (ต้องมี token) */
function getReport(days) {
  return { ok: true, report: buildWatchReport(days || 7), generatedAt: new Date().toISOString() };
}

/* ==========================================================
 * Setup + utilities
 * ========================================================== */

function getActiveSpreadsheet() {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    const props = PropertiesService.getScriptProperties();
    const sheetId = props.getProperty("SPREADSHEET_ID") || "1WoR9gqLx745Yyz_Ls415ttRVAE_1ZWkC3BYNDlt53kQ";
    if (sheetId) {
      try { ss = SpreadsheetApp.openById(sheetId); } catch (e) {}
    }
  }
  return ss;
}

/** รันครั้งเดียวตอนติดตั้ง: สร้างชีตและหัวตารางทั้งหมด */
function setup() {
  const ss = getActiveSpreadsheet();
  if (!ss) return;
  ensureSheet(ss, SHEETS.ASSESSMENTS, [
    "timestamp", "assessmentId", "studentId", "lineUserId",
    "st5Score", "q2Score", "q9Score", "q9Item9", "q8Score",
    "behaviorIndex", "behaviorFlags", "conflictFlag", "cameraUsed",
    "riskLevel", "riskReason", "behaviorDetail",
    "displayName", "userType",
  ]);
  ensureSheet(ss, SHEETS.ALERTS, [
    "timestamp", "alertId", "assessmentId", "studentId",
    "riskLevel", "reason", "status", "dueAt",
    "assignedTo", "contactedAt", "careNote", "escalations",
  ]);
  ensureSheet(ss, SHEETS.TEACHERS, [
    "teacherId", "name", "lineUserId", "active",
  ]);
  ensureSheet(ss, SHEETS.BINDINGS, [
    "lineUserId", "studentId", "boundAt",
  ]);
  ensureSheet(ss, SHEETS.ROSTER, [
    "studentId", "name", "year",
  ]);
  ensureSheet(ss, SHEETS.REPORTS, [
    "generatedAt", "periodDays", "total",
    "red", "orange", "yellow", "green",
    "cameraConflicts", "openAlerts", "overdue", "byStudentYear",
  ]);
  ensureSheet(ss, SHEETS.ERRORS, [
    "timestamp", "where", "error", "context",
  ]);
}

function ensureSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function getSheet(name) {
  const ss = getActiveSpreadsheet();
  if (!ss) throw new Error("ไม่สามารถเปิด Spreadsheet ได้ — โปรดเปิดสคริปต์จากใน Google Sheet หรือตั้งค่า SPREADSHEET_ID ใน Script Properties");
  let sh = ss.getSheetByName(name);
  if (!sh) {
    setup(); // Auto-create sheets if not initialized yet
    sh = ss.getSheetByName(name);
  }
  if (!sh) throw new Error("ไม่พบชีต " + name);
  return sh;
}

/** กัน formula injection: ค่าที่ขึ้นต้นด้วย = + - @ ให้เติม ' นำหน้า */
function sanitize(v) {
  const s = String(v == null ? "" : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function numOrNull(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function logError(where, err, context) {
  try {
    getSheet(SHEETS.ERRORS).appendRow([new Date(), where, String(err), String(context || "")]);
  } catch (e) {
    console.error(where, err); // ถ้าชีต error เองก็ยังเหลือ log ใน console
  }
}

function output(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
