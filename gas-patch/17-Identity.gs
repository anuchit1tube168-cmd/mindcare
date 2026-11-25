
/* ==========================================================
 * 17-Identity — แปลงชื่อที่นักเรียนกรอก/ชื่อ LINE เป็น "รหัส 7 หลัก + ชื่อจริง" ก่อนบันทึกและแจ้งเตือน
 *
 * ลำดับการค้นหา (หยุดที่อันแรกที่เจอ):
 *  1) รหัส 7 หลักที่อยู่ในทะเบียนอยู่แล้ว
 *  2) LINE userId ที่เคยผูกรหัสไว้ (ชีต Bindings)
 *  3) ชีต IdAlias ที่ ผปค. ยืนยันแล้ว (คอลัมน์ "รหัสจริง" มีค่า)
 *  4) เดาจาก "เลขที่ + ชื่อ" เทียบทะเบียน — ใช้เฉพาะเมื่อชี้ได้คนเดียว และติดป้าย "โปรดตรวจ"
 *     (ไม่ผูก LINE ให้อัตโนมัติ กันผูกผิดคน)
 *  ถ้ายังหาไม่ได้: เพิ่มแถวใน IdAlias ให้ ผปค. เติมรหัสจริงครั้งเดียว ครั้งต่อไประบบใช้รหัสจริงเอง
 * ========================================================== */

const ID_ALIAS_SHEET = "IdAlias";

/** อ่านทะเบียนจริง (เฉพาะแถวนักเรียน) เรียงตามรหัสในแต่ละชั้นปี → ได้เลขที่ตามลำดับ */
function rosterStudents_() {
  const rows = getSheet(SHEETS.ROSTER).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][0] || "").trim();
    if (/^\d{7}$/.test(id) && String(rows[i][4] || "นักเรียน") === "นักเรียน") {
      out.push({ id: id, name: String(rows[i][1] || ""), year: String(rows[i][2] || "") });
    }
  }
  const byYear = {};
  out.forEach(function (r) { (byYear[r.year] = byYear[r.year] || []).push(r); });
  Object.keys(byYear).forEach(function (y) {
    byYear[y].sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    byYear[y].forEach(function (r, i) { r.no = i + 1; });
  });
  return out;
}

function firstNameOf_(fullName) {
  return String(fullName || "").replace(/^นพอ\.?\s*(\(ช\))?\s*/, "").trim().split(/\s+/)[0] || "";
}

/** แยก "เลขที่" และชื่อภาษาไทยจากข้อความที่กรอก เช่น "LINE: 29 นพอ.ณัฐธิชา(บีม)" → {no:29, th:["ณัฐธิชา","บีม"]} */
function parseClaim_(text) {
  const t = String(text || "").replace(/^(N-|LINE:\s*)/, "");
  const m = t.match(/^\s*(\d{1,2})(?!\d)/);
  const words = (t.match(/[ก-๙]{2,}/g) || []).filter(function (w) { return w !== "นพอ"; });
  return { no: m ? Number(m[1]) : null, th: words, latin: (t.match(/[A-Za-z]{3,}/g) || []).map(function (w) { return w.toLowerCase(); }) };
}

/** เทียบชื่ออังกฤษคร่าวๆ เช่น Jirapha ~ จิราภา (ใช้ร่วมกับเลขที่เท่านั้น) */
function latinLooksLike_(latin, thaiFirst) {
  const map = { "ก": "k", "ข": "k", "ค": "k", "ง": "ng", "จ": "j", "ฉ": "ch", "ช": "ch", "ซ": "s", "ญ": "y", "ฐ": "t", "ฑ": "t", "ณ": "n",
    "ด": "d", "ต": "t", "ถ": "t", "ท": "t", "ธ": "t", "น": "n", "บ": "b", "ป": "p", "ผ": "p", "พ": "p", "ภ": "p", "ฟ": "f", "ม": "m",
    "ย": "y", "ร": "r", "ล": "l", "ว": "w", "ศ": "s", "ษ": "s", "ส": "s", "ห": "h", "ฬ": "l", "อ": "", "ฮ": "h" };
  const cons = Array.from(String(thaiFirst)).map(function (c) { return map[c] === undefined ? "" : map[c]; }).join("").replace(/h/g, "");
  const lat = String(latin).replace(/[aeiouh]/g, "");
  return cons.length >= 2 && lat.length >= 2 && (lat.indexOf(cons.slice(0, 3)) === 0 || cons.indexOf(lat.slice(0, 3)) === 0);
}

function idAliasRows_() {
  try {
    const sh = getSheet(SHEETS.ROSTER).getParent().getSheetByName(ID_ALIAS_SHEET);
    return sh ? sh.getDataRange().getValues() : [];
  } catch (e) { return []; }
}

/**
 * คืน { id, name, year, how, confirmed } หรือ null
 * how: "roster" | "binding" | "alias" | "guess"
 */
function resolveStudentIdentity_(claimedId, lineUserId, displayName) {
  const claim = String(claimedId || "").trim();
  const students = rosterStudents_();
  const byId = {};
  students.forEach(function (s) { byId[s.id] = s; });

  if (byId[claim]) return { id: claim, name: byId[claim].name, year: byId[claim].year, how: "roster", confirmed: true };

  const bound = lineUserId ? getStudentIdByLineUserId(lineUserId) : null;
  if (bound && byId[bound]) return { id: bound, name: byId[bound].name, year: byId[bound].year, how: "binding", confirmed: true };

  const keys = [claim, "N-" + String(displayName || "").trim(), "LINE: " + String(displayName || "").trim()];
  const alias = idAliasRows_();
  for (let i = 1; i < alias.length; i++) {
    const real = String(alias[i][3] || "").trim();
    if (/^\d{7}$/.test(real) && byId[real] && keys.indexOf(String(alias[i][0] || "").trim()) >= 0) {
      return { id: real, name: byId[real].name, year: byId[real].year, how: "alias", confirmed: true };
    }
  }

  // เดาจากเลขที่ + ชื่อ (ต้องชี้ได้คนเดียวเท่านั้น)
  const c = parseClaim_(claim + " " + (displayName || ""));
  let cands = students.filter(function (s) {
    const fn = firstNameOf_(s.name);
    const thaiHit = c.th.some(function (w) { return w === fn || (w.length >= 3 && fn.indexOf(w) === 0); });
    const latHit = c.no !== null && s.no === c.no && c.latin.some(function (l) { return latinLooksLike_(l, fn); });
    return thaiHit || latHit;
  });
  if (cands.length > 1 && c.no !== null) cands = cands.filter(function (s) { return s.no === c.no; });
  if (cands.length === 1) {
    const s = cands[0];
    return { id: s.id, name: s.name, year: s.year, how: "guess", confirmed: false };
  }
  return null;
}

/** บันทึกชื่อที่ยังจับคู่ไม่ได้ (หรือจับคู่แบบเดา) ลง IdAlias ให้ ผปค. ยืนยัน — ไม่สร้างซ้ำ */
function rememberAliasForReview_(claimedId, guess) {
  try {
    const ss = getSheet(SHEETS.ROSTER).getParent();
    let sh = ss.getSheetByName(ID_ALIAS_SHEET);
    if (!sh) {
      sh = ss.insertSheet(ID_ALIAS_SHEET);
      sh.appendRow(["รหัส/ชื่อที่กรอกมา", "ชื่อจริง", "ชั้นปี", "รหัสจริง", "หมายเหตุ (จับคู่จากเลขที่+ชื่อ ควรตรวจ)"]);
    }
    const vals = sh.getDataRange().getValues();
    for (let i = 1; i < vals.length; i++) if (String(vals[i][0]).trim() === claimedId) return;
    sh.appendRow([claimedId, guess ? guess.name : "", guess ? guess.year : "", "",
      guess ? "ระบบเดาว่าเป็น " + guess.id + " — ถ้าถูกต้องให้ใส่รหัสนี้ในช่อง 'รหัสจริง'" : "ยังหาไม่ได้ — โปรดเติมรหัสจริง 7 หลัก"]);
  } catch (e) { logError("rememberAliasForReview_", e, claimedId); }
}

/** เรียกใน handleSubmit / handleTalkRequest ก่อนบันทึก — แก้ d ในที่ */
function applyResolvedIdentity_(d) {
  const claimed = String(d.studentId || "").trim();
  let r = null;
  try { r = resolveStudentIdentity_(claimed, d.lineUserId, d.displayName); } catch (e) { logError("resolveStudentIdentity_", e, claimed); }
  if (r && (r.confirmed || r.how === "guess")) {
    if (r.how === "guess") {
      d._idNote = "จับคู่อัตโนมัติจาก \"" + claimed + "\" — โปรดตรวจในชีต IdAlias";
      rememberAliasForReview_(claimed, r);
      // ไม่เปลี่ยนรหัสที่บันทึกจนกว่า ผปค. ยืนยัน แต่แสดงชื่อ/รหัสที่น่าจะเป็นในการแจ้งเตือน
      d._guess = r;
      return d;
    }
    if (r.id !== claimed) d._idNote = "แปลงจาก \"" + claimed + "\" (" + ({ binding: "LINE ที่ผูกไว้", alias: "IdAlias ที่ยืนยันแล้ว", roster: "ทะเบียน" }[r.how]) + ")";
    d.studentId = r.id;
    d.displayName = r.name;
    d.userType = "student";
    return d;
  }
  if (!/^\d{7}$/.test(claimed)) {
    d._idNote = "ยังไม่ทราบรหัส 7 หลัก — เติมรหัสจริงในชีต IdAlias ครั้งเดียว ครั้งต่อไประบบจะใช้รหัสจริงเอง";
    rememberAliasForReview_(claimed, null);
  }
  return d;
}

/** ทดสอบใน editor */
function testResolveIdentity() {
  ["N-08 Jirapha (ว่าน)", "LINE: 29 นพอ.ณัฐธิชา(บีม)", "6903955", "N-สมชาย ใจดี"].forEach(function (x) {
    Logger.log(x + " → " + JSON.stringify(resolveStudentIdentity_(x, "", "")));
  });
}
