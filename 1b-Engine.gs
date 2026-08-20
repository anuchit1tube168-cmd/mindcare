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
/**
 * สร้างไฟล์รายงาน Excel (.xlsx) แบบสมบูรณ์ระดับมืออาชีพ
 * ประกอบด้วย 4 แท็บในไฟล์เดียว:
 *  1. สรุปภาพรวมผู้บริหาร (Executive Summary)
 *  2. สรุปรายชั้นปี (Yearly Summary)
 *  3. รายงานผลรายคนทุกคน (เรียงรหัส + คะแนน ST-5, 2Q, 9Q, 8Q, ดัชนีกล้อง AI)
 *  4. ทะเบียนกลุ่มเสี่ยงที่ต้องดูแล (At-Risk Follow-up)
 */
function exportReportToDrive(report) {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const now = new Date();
  const stamp = Utilities.formatDate(now, "Asia/Bangkok", "yyyyMMdd_HHmm");
  const title = "รายงานสรุปสุขภาพจิต_วพอ_พอ_" + stamp;

  // สร้าง Google Sheet ชั่วคราว
  const ss = SpreadsheetApp.create(title);
  
  // Sheet 1: สรุปภาพรวมผู้บริหาร
  const s1 = ss.getSheets()[0];
  s1.setName("สรุปภาพรวมผู้บริหาร");
  const byYear = report.byStudentYear || {};
  const s1Rows = [
    ["รายงานผลการประเมินสุขภาพจิตและดัชนีความเครียด (Executive Summary)", "", "", ""],
    ["วิทยาลัยพยาบาลทหารอากาศ กรมแพทย์ทหารอากาศ", "", "", ""],
    ["สร้างเมื่อ", Utilities.formatDate(now, "Asia/Bangkok", "dd/MM/yyyy HH:mm"), "ช่วงข้อมูลย้อนหลัง(วัน)", report.periodDays || 30],
    ["", "", "", ""],
    ["๑) สรุปภาพรวมตามระดับความเสี่ยง (Risk Levels)", "จำนวน (คน/ครั้ง)", "สัดส่วน (%)", "เกณฑ์การดูแลส่งต่อ"],
    ["RED (เสี่ยงสูงสุด)", report.byRisk.RED, (report.total ? (Math.round(report.byRisk.RED / report.total * 1000) / 10 + "%") : "-"), "พบแพทย์ รพ.ภูมิพลอดุลยเดช พอ. ทันที (ภายใน 1 ชม.)"],
    ["ORANGE (สำคัญ)", report.byRisk.ORANGE, (report.total ? (Math.round(report.byRisk.ORANGE / report.total * 1000) / 10 + "%") : "-"), "พบอาจารย์/นัดหมายแพทย์ภายใน 3 วัน (72 ชม.)"],
    ["YELLOW (ควรชวนคุย/เฝ้าระวัง)", report.byRisk.YELLOW, (report.total ? (Math.round(report.byRisk.YELLOW / report.total * 1000) / 10 + "%") : "-"), "อาจารย์ที่ปรึกษาชวนคุยภายใน 1 สัปดาห์"],
    ["GREEN (ปกติ)", report.byRisk.GREEN, (report.total ? (Math.round(report.byRisk.GREEN / report.total * 1000) / 10 + "%") : "-"), "ส่งเสริมสุขภาวะและการดูแลสุขภาพจิตตนเอง"],
    ["รวมทั้งหมด", report.total, "100%", "-"],
    ["", "", "", ""],
    ["๒) ดัชนีพฤติกรรมใบหน้า AI (Behavioral AI)", "จำนวนครั้ง", "", ""],
    ["พบสัญญาณขัดแย้ง (แบบสอบถามปกติแต่กล้องพบเครียด)", report.cameraConflicts, "", ""],
    ["", "", "", ""],
    ["๓) สถานะการติดตามงานดูแล (Alert Follow-up)", "จำนวนงาน", "เกินกำหนด SLA", ""],
    ["งานที่อยู่ระหว่างติดตามดูแล", report.openAlerts, report.overdue, ""]
  ];
  s1.getRange(1, 1, s1Rows.length, 4).setValues(s1Rows);
  s1.getRange(1, 1, 1, 4).merge().setFontWeight("bold").setFontSize(13);
  s1.getRange(2, 1, 1, 4).merge().setFontColor("#555555").setFontSize(11);
  [5, 12, 14].forEach(function (r) {
    s1.getRange(r, 1, 1, 4).setFontWeight("bold").setBackground("#1B4332").setFontColor("#FFFFFF");
  });
  s1.autoResizeColumns(1, 4);

  // Sheet 2: รายงานผลประเมินรายคน (เฉพาะผลประเมินครั้งล่าสุดของแต่ละคน เรียงตามรหัส)
  const s2 = ss.insertSheet("ผลประเมินรายคนล่าสุด");
  const rawAssessments = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();

  // ดึงเฉพาะผลล่าสุด 1 คน ต่อ 1 รายการ (Latest Record per Student)
  const latestMap = {};
  rawAssessments.forEach(function (a) {
    if (!a.studentId) return;
    const sId = String(a.studentId).trim();
    if (!latestMap[sId] || new Date(a.ts) > new Date(latestMap[sId].ts)) {
      latestMap[sId] = a;
    }
  });

  const assessments = Object.values(latestMap);
  assessments.sort(function (a, b) {
    return String(a.studentId || "").localeCompare(String(b.studentId || ""));
  });

  const s2Headers = [
    "ลำดับ", "รหัสประจำตัว", "ยศ-ชื่อ-สกุล", "ชั้นปี/รุ่น", "ระดับความเสี่ยง",
    "ST-5 (เครียด /15)", "2Q (คัดกรอง /2)", "9Q (ซึมเศร้า /27)", "8Q (ทำร้ายตนเอง /52)",
    "ดัชนีกล้อง AI (/100)", "สัญญาณขัดแย้ง", "วันที่-เวลาทำล่าสุด", "เหตุผลการแปลผล", "สถานะติดตาม"
  ];
  const s2Rows = [s2Headers];
  assessments.forEach(function (a, idx) {
    const info = roster[a.studentId] || {};
    const al = alerts[a.studentId] || {};
    s2Rows.push([
      idx + 1,
      '="' + String(a.studentId) + '"',
      info.name ? info.name : (a.name || "-"),
      info.year ? info.year : "-",
      a.level,
      a.st5 !== null && a.st5 !== undefined && a.st5 !== "" ? a.st5 : "-",
      a.q2 !== null && a.q2 !== undefined && a.q2 !== "" ? a.q2 : "-",
      a.q9 !== null && a.q9 !== undefined && a.q9 !== "" ? a.q9 : "-",
      a.q8 !== null && a.q8 !== undefined && a.q8 !== "" ? a.q8 : "-",
      a.camIndex !== null && a.camIndex !== undefined && a.camIndex !== "" ? a.camIndex : "-",
      a.conflict ? "พบขัดแย้ง" : "ปกติ",
      Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss"),
      a.reason || "-",
      al.status || "-"
    ]);
  });
  s2.getRange(1, 1, s2Rows.length, s2Headers.length).setValues(s2Rows);
  s2.getRange(1, 1, 1, s2Headers.length).setFontWeight("bold").setBackground("#1B4332").setFontColor("#FFFFFF");
  s2.setFrozenRows(1);
  s2.autoResizeColumns(1, s2Headers.length);

  // Sheet 3: สรุปรายชั้นปี (จากผลล่าสุด)
  const s3 = ss.insertSheet("สรุปรายชั้นปี");
  const yearStats = {};
  assessments.forEach(function (a) {
    const info = roster[a.studentId] || {};
    const y = info.year ? String(info.year) : (String(a.studentId || "").substring(0, 2) || "อื่นๆ");
    if (!yearStats[y]) yearStats[y] = { count: 0, students: {}, RED: 0, ORANGE: 0, YELLOW: 0, GREEN: 0 };
    yearStats[y].count++;
    yearStats[y].students[a.studentId] = true;
    if (yearStats[y][a.level] !== undefined) yearStats[y][a.level]++;
  });

  const s3Headers = ["ชั้นปี/รุ่น", "จำนวนนักเรียนล่าสุด (คน)", "🔴 RED", "🟠 ORANGE", "🟡 YELLOW", "🟢 GREEN", "รวมเคสต้องดูแล", "สัดส่วนต้องดูแล (%)"];
  const s3Rows = [s3Headers];
  Object.keys(yearStats).sort().forEach(function (yKey) {
    const ys = yearStats[yKey];
    const atRisk = ys.RED + ys.ORANGE + ys.YELLOW;
    const stdCount = Object.keys(ys.students).length;
    s3Rows.push([
      yKey, stdCount, ys.RED, ys.ORANGE, ys.YELLOW, ys.GREEN, atRisk,
      stdCount ? (Math.round(atRisk / stdCount * 1000) / 10 + "%") : "-"
    ]);
  });
  s3.getRange(1, 1, s3Rows.length, s3Headers.length).setValues(s3Rows);
  s3.getRange(1, 1, 1, s3Headers.length).setFontWeight("bold").setBackground("#1B4332").setFontColor("#FFFFFF");
  s3.setFrozenRows(1);
  s3.autoResizeColumns(1, s3Headers.length);

  // Sheet 4: รายการเคสกลุ่มเสี่ยงล่าสุด (RED / ORANGE / YELLOW)
  const s4 = ss.insertSheet("กลุ่มเสี่ยงที่ต้องดูแล");
  const riskList = assessments.filter(function (a) { return a.level === "RED" || a.level === "ORANGE" || a.level === "YELLOW"; });
  const s4Headers = ["ระดับความเสี่ยง", "รหัสประจำตัว", "ยศ-ชื่อ-สกุล", "ชั้นปี/รุ่น", "ST-5 (เครียด)", "9Q (ซึมเศร้า)", "8Q (ทำร้ายตนเอง)", "ดัชนีกล้อง AI", "วันที่-เวลาทำล่าสุด", "เหตุผลข้อบ่งชี้", "สถานะการติดตาม"];
  const s4Rows = [s4Headers];
  riskList.forEach(function (a) {
    const info = roster[a.studentId] || {};
    const al = alerts[a.studentId] || {};
    s4Rows.push([
      a.level,
      '="' + String(a.studentId) + '"',
      info.name ? info.name : (a.name || "-"),
      info.year ? info.year : "-",
      a.st5 !== null && a.st5 !== undefined ? a.st5 : "-",
      a.q9 !== null && a.q9 !== undefined ? a.q9 : "-",
      a.q8 !== null && a.q8 !== undefined ? a.q8 : "-",
      a.camIndex !== null && a.camIndex !== undefined ? a.camIndex : "-",
      Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss"),
      a.reason || "-",
      al.status || "แจ้งแล้ว"
    ]);
  });
  s4.getRange(1, 1, s4Rows.length, s4Headers.length).setValues(s4Rows);
  s4.getRange(1, 1, 1, s4Headers.length).setFontWeight("bold").setBackground("#1B4332").setFontColor("#FFFFFF");
  s4.setFrozenRows(1);
  s4.autoResizeColumns(1, s4Headers.length);

  SpreadsheetApp.flush();

  // แปลงเป็น .xlsx ผ่าน Drive export URL
  const ssId = ss.getId();
  const url = "https://docs.google.com/spreadsheets/d/" + ssId + "/export?format=xlsx";
  const token = ScriptApp.getOAuthToken();
  const resp = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token } });
  const xlsxBlob = resp.getBlob().setName(title + ".xlsx");
  const file = folder.createFile(xlsxBlob);

  // ลบ Google Sheet ชั่วคราวทิ้ง เหลือแต่ .xlsx สมบูรณ์ใน Drive
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
