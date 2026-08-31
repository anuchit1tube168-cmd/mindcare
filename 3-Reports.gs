/* ==========================================================
 * เมนูในชีต + รายงานที่ประมวลผลจากข้อมูลใน Google Sheet
 * เปิดไฟล์ Sheet แล้วจะเห็นเมนู "ระบบดูแลใจ" บนแถบเมนู
 * กดสร้างรายงานได้ทันที ไม่ต้องเข้า Apps Script
 * (ครั้งแรกต้องรีเฟรชหน้า Sheet หนึ่งครั้งเมนูจึงจะขึ้น)
 * ========================================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("ระบบดูแลใจ")
    .addItem("สร้างรายงานทั้งหมด", "buildAllSheetReports")
    .addSeparator()
    .addItem("รายงานรายชั้นปี", "buildYearReport")
    .addItem("รายงานรายบุคคล", "buildPersonReport")
    .addItem("รายงานกลุ่มเสี่ยง (ต้องดูแล)", "buildRiskReport")
    .addSeparator()
    .addItem("ส่งออกไฟล์รายงานเข้า Drive", "menuExportDrive")
    .addItem("ส่งสรุปเข้า LINE / Telegram", "menuPushSummary")
    .addItem("ทดสอบระบบ", "runSelfTest")
    .addToUi();
}

/** ลำดับความรุนแรง ใช้เทียบหาระดับสูงสุดและใช้เรียงลำดับ */
function riskRank(level) {
  return { RED: 4, ORANGE: 3, YELLOW: 2, GREEN: 1 }[level] || 0;
}
function riskThai(level) {
  return { RED: "แดง (เสี่ยงสูงสุด)", ORANGE: "ส้ม (สำคัญ)",
           YELLOW: "เหลือง (ควรชวนคุย)", GREEN: "เขียว (ปกติ)" }[level] || level;
}

/** map รหัสนักเรียน -> {name, year} จากชีต Roster */
function rosterMap() {
  const map = {};
  const rows = getSheet(SHEETS.ROSTER).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][0]).trim();
    if (id) map[id] = { name: rows[i][1] || "", year: rows[i][2] || "" };
  }
  return map;
}

/** map รหัสนักเรียน -> สถานะงานติดตามล่าสุด จากชีต Alerts */
function alertStatusMap() {
  const map = {};
  const rows = getSheet(SHEETS.ALERTS).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][3]).trim();
    if (!id) continue;
    map[id] = { status: rows[i][6] || "", dueAt: rows[i][7] || "", note: rows[i][10] || "" };
  }
  return map;
}

/** อ่านผลประเมินทั้งหมด แปลงเป็น object ให้ใช้ง่าย */
function loadAssessments() {
  const rows = getSheet(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    out.push({
      ts: r[0], id: r[1], studentId: String(r[2]).trim(),
      st5: r[4], q2: r[5], q9: r[6], q8: r[8],
      camIndex: r[9], conflict: r[11] === true, camUsed: r[12] === true,
      level: r[13], reason: r[14],
      name: r[16] || "", userType: r[17] || "student",
    });
  }
  return out;
}

/** เขียนตารางลงชีตแบบมาตรฐาน OBE Military Docs (RTAF Professional Styling) */
function writeReportSheet(sheetName, title, header, rows) {
  const ss = getActiveSpreadsheet();
  if (!ss) throw new Error("ไม่สามารถเปิด Spreadsheet ได้");
  let sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  sh.clear();

  const stamp = "ข้อมูลระบบดูแลใจ วพอ.พอ. | ประมวลผลล่าสุด ณ วันที่ " +
    Utilities.formatDate(new Date(), "Asia/Bangkok", "dd/MM/yyyy เวลา HH:mm น.");
  const table = [[title], [stamp], header].concat(rows.length ? rows : [["(ยังไม่มีข้อมูล)"]]);

  const width = header.length;
  const padded = table.map(function (r) {
    const copy = r.slice(0, width);
    while (copy.length < width) copy.push("");
    return copy;
  });

  const totalRows = padded.length;
  const range = sh.getRange(1, 1, totalRows, width);
  range.setValues(padded);

  // ตั้งค่าฟอนต์มาตรฐาน Sarabun / สารบรรณ
  range.setFontFamily("Sarabun");

  // หัวเรื่องหลัก (Row 1) - สีกรมท่าทหารอากาศ (RTAF Navy #1F3864)
  sh.getRange(1, 1, 1, width)
    .merge()
    .setFontWeight("bold")
    .setFontSize(14)
    .setBackground("#1F3864")
    .setFontColor("#FFFFFF")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(1, 38);

  // คำอธิบายเวลา (Row 2) - สีเทาสะอาดตา
  sh.getRange(2, 1, 1, width)
    .merge()
    .setFontColor("#334155")
    .setFontSize(10)
    .setBackground("#F1F5F9")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(2, 24);

  // หัวตารางคอลัมน์ (Row 3) - สีกรมท่าสว่าง (#2E75B6 / #1B4332)
  sh.getRange(3, 1, 1, width)
    .setFontWeight("bold")
    .setFontSize(11)
    .setBackground("#2E75B6")
    .setFontColor("#FFFFFF")
    .setWrap(true)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(3, 32);

  // ข้อมูลแถว (Rows 4 เป็นต้นไป)
  if (totalRows > 3) {
    const dataRange = sh.getRange(4, 1, totalRows - 3, width);
    dataRange.setFontSize(10).setVerticalAlignment("middle");
    sh.setRowHeights(4, totalRows - 3, 24);

    // เส้นขอบตาราง (Borders)
    dataRange.setBorder(true, true, true, true, true, true, "#CBD5E1", SpreadsheetApp.BorderStyle.SOLID);

    // สลับสีแถว (Zebra striping)
    for (let r = 4; r <= totalRows; r++) {
      if (r % 2 === 0) {
        sh.getRange(r, 1, 1, width).setBackground("#F8FAFC");
      } else {
        sh.getRange(r, 1, 1, width).setBackground("#FFFFFF");
      }
    }
  }

  sh.setFrozenRows(3);
  sh.autoResizeColumns(1, width);
  return sh;
}

/* ---------- รายงาน 1: แยกชั้นปี ---------- */
function buildYearReport() {
  const data = loadAssessments();
  const roster = rosterMap();
  const byYear = {};
  const yearNames = { "69": "ชั้นปีที่ 1 (รุ่น 69)", "68": "ชั้นปีที่ 2 (รุ่น 68)", "67": "ชั้นปีที่ 3 (รุ่น 67)", "66": "ชั้นปีที่ 4 (รุ่น 66)" };

  data.forEach(function (a) {
    const info = roster[a.studentId];
    const sId = String(a.studentId || "").trim();
    const prefix = sId.length >= 2 ? sId.substring(0, 2) : "";
    const year = (info && info.year) ? info.year : (yearNames[prefix] || (prefix ? ("รุ่น " + prefix) : (a.userType === "student" ? "ไม่ระบุชั้นปี" : "บุคลากร/บุคคลภายนอก")));

    if (!byYear[year]) {
      byYear[year] = { times: 0, people: {}, RED: 0, ORANGE: 0, YELLOW: 0, GREEN: 0,
                       conflict: 0, camSum: 0, camN: 0 };
    }
    const y = byYear[year];
    y.times++;
    y.people[a.studentId] = true;
    if (y[a.level] !== undefined) y[a.level]++;
    if (a.conflict) y.conflict++;
    if (typeof a.camIndex === "number") { y.camSum += a.camIndex; y.camN++; }
  });

  const rows = Object.keys(byYear).sort().map(function (year) {
    const y = byYear[year];
    const need = y.RED + y.ORANGE + y.YELLOW;
    const count = Object.keys(y.people).length;
    return [
      year, count, y.times,
      y.RED, y.ORANGE, y.YELLOW, y.GREEN, need,
      count ? Math.round(need / count * 1000) / 10 + "%" : "-",
      y.conflict,
      y.camN ? Math.round(y.camSum / y.camN * 10) / 10 : "-",
    ];
  });

  writeReportSheet(SHEETS.RPT_YEAR, "รายงานสรุปแยกชั้นปี — ระบบดูแลใจ วพอ.พอ.",
    ["ชั้นปี", "จำนวนคนที่ทำ (คน)", "จำนวนครั้งทั้งหมด", "🔴 แดง", "🟠 ส้ม", "🟡 เหลือง", "🟢 เขียว",
     "รวมกลุ่มต้องดูแล (คน)", "สัดส่วนต้องดูแล (%)", "สัญญาณกล้องขัดแย้ง (เคส)", "ดัชนีกล้องเฉลี่ย"],
    rows);
  return rows.length;
}

/* ---------- รายงาน 2: รายบุคคล ---------- */
function buildPersonReport() {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();
  const byPerson = {};
  const yearNames = { "69": "ปี 1 (รุ่น 69)", "68": "ปี 2 (รุ่น 68)", "67": "ปี 3 (รุ่น 67)", "66": "ปี 4 (รุ่น 66)" };

  data.forEach(function (a) {
    if (!byPerson[a.studentId]) {
      byPerson[a.studentId] = { times: 0, last: null, maxLevel: "GREEN", nameFromForm: "" };
    }
    const p = byPerson[a.studentId];
    p.times++;
    if (!p.last || new Date(a.ts) > new Date(p.last.ts)) p.last = a;
    if (riskRank(a.level) > riskRank(p.maxLevel)) p.maxLevel = a.level;
    if (a.name) p.nameFromForm = a.name;
  });

  // เรียงลำดับ: นำคนที่เพิ่งทำล่าสุดขึ้นก่อน (Timeline ล่าสุดอยู่ด้านบน)
  const ordered = Object.keys(byPerson).sort(function (a, b) {
    return new Date(byPerson[b].last.ts) - new Date(byPerson[a].last.ts);
  });

  const rows = ordered.map(function (id) {
    const p = byPerson[id];
    const info = roster[id];
    const last = p.last;
    const al = alerts[id];
    const sId = String(id).trim();
    const prefix = sId.length >= 2 ? sId.substring(0, 2) : "";
    const derivedYear = (info && info.year) ? info.year : (yearNames[prefix] || (prefix ? ("รุ่น " + prefix) : (last.userType === "student" ? "-" : "บุคลากร/ภายนอก")));

    return [
      '="' + sId + '"',
      info && info.name ? info.name : (p.nameFromForm || "(ไม่พบในทะเบียน)"),
      derivedYear,
      Utilities.formatDate(new Date(last.ts), "Asia/Bangkok", "dd/MM/yyyy HH:mm"),
      riskThai(last.level),
      riskThai(p.maxLevel),
      last.st5 === "" ? "-" : last.st5,
      last.q2 === "" ? "-" : last.q2,
      last.q9 === "" ? "-" : last.q9,
      last.q8 === "" ? "-" : last.q8,
      typeof last.camIndex === "number" ? last.camIndex : "-",
      last.conflict ? "ใช่" : "-",
      p.times,
      al ? al.status : "-",
      al ? al.note : "-",
    ];
  });

  writeReportSheet(SHEETS.RPT_PERSON, "รายงานรายบุคคลล่าสุด — ระบบดูแลใจ วพอ.พอ. (เปรียบเทียบผลประเมิน)",
    ["รหัสประจำตัว", "ยศ-ชื่อ-สกุล", "ชั้นปี/รุ่น", "วันเวลาทำล่าสุด", "ระดับล่าสุด",
     "ระดับสูงสุดที่เคยพบ", "ST-5", "2Q", "9Q", "8Q", "ดัชนีกล้อง AI", "สัญญาณขัดแย้ง",
     "จำนวนครั้งที่ทำ", "สถานะติดตามงาน", "บันทึกการดูแล"],
    rows);
  return rows.length;
}

/* ---------- รายงาน 3: กลุ่มเสี่ยง (เฉพาะที่ต้องดูแล) ---------- */
function buildRiskReport() {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();

  const rows = data
    .filter(function (a) { return a.level === "RED" || a.level === "ORANGE" || a.level === "YELLOW"; })
    .sort(function (a, b) {
      const d = riskRank(b.level) - riskRank(a.level);
      return d !== 0 ? d : new Date(b.ts) - new Date(a.ts);   // รุนแรงก่อน แล้วใหม่สุดก่อน
    })
    .map(function (a) {
      const info = roster[a.studentId];
      const al = alerts[a.studentId];
      return [
        riskThai(a.level),
        a.studentId,
        info && info.name ? info.name : (a.name || "(ไม่พบในทะเบียน)"),
        info && info.year ? info.year : "-",
        Utilities.formatDate(new Date(a.ts), "Asia/Bangkok", "dd/MM/yyyy HH:mm"),
        a.st5 === "" ? "-" : a.st5,
        a.q9 === "" ? "-" : a.q9,
        a.q8 === "" ? "-" : a.q8,
        typeof a.camIndex === "number" ? a.camIndex : "-",
        a.conflict ? "ใช่" : "",
        a.reason,
        al ? al.status : "",
      ];
    });

  const sh = writeReportSheet(SHEETS.RPT_RISK,
    "รายงานกลุ่มเสี่ยงที่ต้องดูแล — เรียงตามความรุนแรง",
    ["ระดับ", "รหัส/ผู้ใช้", "ชื่อ", "ชั้นปี", "วันเวลา", "ST-5", "9Q", "8Q",
     "ดัชนีกล้อง", "สัญญาณขัดแย้ง", "เหตุผล", "สถานะติดตาม"],
    rows);

  // ระบายสีแถวตามระดับ ให้กวาดตาเห็นเคสด่วนทันที
  const colors = { "แดง": "#FDE7E9", "ส้ม": "#FFF1E0", "เหลือง": "#FFFBE0" };
  for (let i = 0; i < rows.length; i++) {
    const key = String(rows[i][0]).split(" ")[0];
    if (colors[key]) sh.getRange(i + 4, 1, 1, 12).setBackground(colors[key]);
  }
  return rows.length;
}

/* ---------- รายงาน 4: รายชื่อ นพอ. ที่ยังไม่ได้ทำแบบประเมิน ---------- */
function buildMissingReport() {
  const missingData = checkMissingStudents();
  const rows = [];

  missingData.missingList.forEach(function(s, idx) {
    rows.push([
      idx + 1,
      s.year,
      '="' + s.id + '"',
      s.name,
      "ยังไม่ได้รับการประเมิน",
      "https://liff.line.me/2010984231-Z7kbSIPp"
    ]);
  });

  const sh = writeReportSheet(SHEETS.RPT_MISSING,
    "บัญชีรายชื่อ นพอ. ที่ยังไม่ได้ทำแบบประเมินสุขภาพใจ — ระบบดูแลใจ วพอ.พอ.",
    ["ลำดับ", "ชั้นปี/รุ่น", "รหัสประจำตัว", "ยศ-ชื่อ-สกุล", "สถานะ", "ลิงก์ทำแบบประเมิน"],
    rows);

  // ระบายสีแถวเตือนสีส้ม/แดงอ่อน
  for (let i = 0; i < rows.length; i++) {
    sh.getRange(i + 4, 1, 1, 6).setBackground("#FEF2F2");
  }

  return rows.length;
}

/* ---------- สร้างทุกรายงานในครั้งเดียว ---------- */
function buildAllSheetReports() {
  const y = buildYearReport();
  const p = buildPersonReport();
  const r = buildRiskReport();
  const m = buildMissingReport();
  const msg = "สร้างรายงานเรียบร้อย — ชั้นปี " + y + " กลุ่ม · รายบุคคล " + p +
    " คน · กลุ่มเสี่ยง " + r + " รายการ · ยังไม่ทำ " + m + " คน";
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, "ระบบดูแลใจ", 6);
  } catch (e) { Logger.log(msg); }
  return msg;
}

/* ---------- เมนู: ส่งออก Drive / ส่งสรุปเข้า LINE-Telegram ---------- */
function menuExportDrive() {
  const res = exportReportNow(7);
  const ui = SpreadsheetApp.getUi();
  ui.alert("ส่งออกเรียบร้อย", "บันทึกไฟล์รายงานลง Google Drive แล้ว\n\n" + res.fileUrl, ui.ButtonSet.OK);
}

function menuPushSummary() {
  const report = weeklyWatchReport();
  const ui = SpreadsheetApp.getUi();
  ui.alert("ส่งสรุปแล้ว",
    "ส่งสรุป 7 วันล่าสุดเข้า LINE และ Telegram แล้ว (ตามที่ตั้งค่าไว้)\n\n" +
    "แดง " + report.byRisk.RED + " · ส้ม " + report.byRisk.ORANGE +
    " · เหลือง " + report.byRisk.YELLOW, ui.ButtonSet.OK);
}
