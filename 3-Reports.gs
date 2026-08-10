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

/** เขียนตารางลงชีตแบบ batch (เร็วกว่าเขียนทีละแถวมาก) */
function writeReportSheet(sheetName, title, header, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  sh.clear();

  const stamp = "สร้างเมื่อ " +
    Utilities.formatDate(new Date(), "Asia/Bangkok", "dd/MM/yyyy HH:mm");
  const table = [[title], [stamp], header].concat(rows.length ? rows : [["(ยังไม่มีข้อมูล)"]]);

  // ทำให้ทุกแถวยาวเท่ากัน ไม่งั้น setValues จะ error
  const width = header.length;
  const padded = table.map(function (r) {
    const copy = r.slice(0, width);
    while (copy.length < width) copy.push("");
    return copy;
  });

  sh.getRange(1, 1, padded.length, width).setValues(padded);
  sh.getRange(1, 1, 1, width).merge().setFontWeight("bold").setFontSize(13);
  sh.getRange(2, 1, 1, width).merge().setFontColor("#666666").setFontSize(10);
  sh.getRange(3, 1, 1, width)
    .setFontWeight("bold").setBackground("#1B4332").setFontColor("#FFFFFF")
    .setWrap(true).setVerticalAlignment("middle");
  sh.setFrozenRows(3);
  sh.autoResizeColumns(1, width);
  return sh;
}

/* ---------- รายงาน 1: แยกชั้นปี ---------- */
function buildYearReport() {
  const data = loadAssessments();
  const roster = rosterMap();
  const byYear = {};

  data.forEach(function (a) {
    const info = roster[a.studentId];
    const year = info && info.year ? info.year : (a.userType === "student" ? "ไม่ระบุชั้นปี" : "บุคลากร/บุคคลภายนอก");
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
    return [
      year, Object.keys(y.people).length, y.times,
      y.RED, y.ORANGE, y.YELLOW, y.GREEN, need,
      y.times ? Math.round(need / y.times * 1000) / 10 + "%" : "-",
      y.conflict,
      y.camN ? Math.round(y.camSum / y.camN * 10) / 10 : "-",
    ];
  });

  writeReportSheet(SHEETS.RPT_YEAR, "รายงานสรุปแยกชั้นปี — ระบบดูแลใจ วพอ.พอ.",
    ["ชั้นปี", "จำนวนคนที่ทำ", "จำนวนครั้ง", "แดง", "ส้ม", "เหลือง", "เขียว",
     "รวมต้องดูแล", "สัดส่วนต้องดูแล", "สัญญาณกล้องขัดแย้ง", "ดัชนีกล้องเฉลี่ย"],
    rows);
  return rows.length;
}

/* ---------- รายงาน 2: รายบุคคล ---------- */
function buildPersonReport() {
  const data = loadAssessments();
  const roster = rosterMap();
  const alerts = alertStatusMap();
  const byPerson = {};

  data.forEach(function (a) {
    if (!byPerson[a.studentId]) {
      byPerson[a.studentId] = { times: 0, last: null, maxLevel: "GREEN", nameFromForm: "" };
    }
    const p = byPerson[a.studentId];
    p.times++;
    if (!p.last || a.ts > p.last.ts) p.last = a;
    if (riskRank(a.level) > riskRank(p.maxLevel)) p.maxLevel = a.level;
    if (a.name) p.nameFromForm = a.name;
  });

  // เรียงก่อนด้วยค่าดิบ (รุนแรงสุดขึ้นก่อน) แล้วจึงแปลงเป็นข้อความไทย
  const ordered = Object.keys(byPerson).sort(function (a, b) {
    const d = riskRank(byPerson[b].maxLevel) - riskRank(byPerson[a].maxLevel);
    return d !== 0 ? d : String(a).localeCompare(String(b));
  });

  const rows = ordered.map(function (id) {
    const p = byPerson[id];
    const info = roster[id];
    const last = p.last;
    const al = alerts[id];
    return [
      id,
      info && info.name ? info.name : (p.nameFromForm || "(ไม่พบในทะเบียน)"),
      info && info.year ? info.year : (last.userType === "student" ? "-" : "บุคลากร/ภายนอก"),
      p.times,
      Utilities.formatDate(new Date(last.ts), "Asia/Bangkok", "dd/MM/yyyy HH:mm"),
      riskThai(last.level),
      riskThai(p.maxLevel),
      last.st5 === "" ? "-" : last.st5,
      last.q9 === "" ? "-" : last.q9,
      last.q8 === "" ? "-" : last.q8,
      typeof last.camIndex === "number" ? last.camIndex : "-",
      last.conflict ? "ใช่" : "",
      al ? al.status : "",
      al ? al.note : "",
    ];
  });

  writeReportSheet(SHEETS.RPT_PERSON, "รายงานรายบุคคล — ระบบดูแลใจ (ข้อมูลอ่อนไหว จำกัดสิทธิ์เข้าถึง)",
    ["รหัส/ผู้ใช้", "ชื่อ", "ชั้นปี", "จำนวนครั้ง", "ทำล่าสุด", "ระดับล่าสุด",
     "ระดับสูงสุดที่เคยพบ", "ST-5", "9Q", "8Q", "ดัชนีกล้อง", "สัญญาณขัดแย้ง",
     "สถานะติดตาม", "บันทึกการดูแล"],
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

/* ---------- สร้างทุกรายงานในครั้งเดียว ---------- */
function buildAllSheetReports() {
  const y = buildYearReport();
  const p = buildPersonReport();
  const r = buildRiskReport();
  const msg = "สร้างรายงานเรียบร้อย — ชั้นปี " + y + " กลุ่ม · รายบุคคล " + p +
    " คน · กลุ่มเสี่ยง " + r + " รายการ";
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
