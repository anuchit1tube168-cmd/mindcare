
/* ==========================================================
 * 15-Security — กันข้อมูลไหลออกจาก Web App (Access: Anyone)
 *
 * ปัญหาเดิม: URL ของ Web App อยู่ในหน้าเว็บสาธารณะ ใครเปิด ?report=... ก็ดึงผลประเมิน
 *   ทั้งรายคนและทั้งชั้นปีได้ และส่ง Telegram update ปลอมให้บอทส่งลิงก์รายงานไปห้องอื่นได้
 * แนวทาง:
 *   - ลิงก์ของผู้ดูแลมี "กุญแจ" (REPORT_KEY ใน Script Properties, สร้างอัตโนมัติ) อยู่ใน path /k/<key>
 *     → ปุ่มใน Telegram ใช้ได้เหมือนเดิม แต่คนนอกเปิด ?report=... ตรงๆ ไม่ได้
 *   - ลิงก์รายงานที่ส่งให้นักเรียนทาง LINE ใช้ลายเซ็นเฉพาะรหัสนั้น (เปิดได้แค่ของตัวเอง)
 *   - บอท Telegram ตอบเฉพาะกลุ่ม TELEGRAM_CHAT_ID
 *   - ถ้าสงสัยว่ากุญแจรั่ว: ลบ REPORT_KEY ใน Script Properties → ระบบสร้างใหม่ ลิงก์เก่าใช้ไม่ได้ทันที
 * ========================================================== */

function reportKey_() {
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty("REPORT_KEY");
  if (!k) {
    k = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
    props.setProperty("REPORT_KEY", k);
  }
  return k;
}

/** URL สำหรับลิงก์ของผู้ดูแล (มีกุญแจใน path) */
function secureApiUrl_() {
  return ScriptApp.getService().getUrl() + "/k/" + reportKey_();
}

function studentSig_(studentId) {
  const raw = Utilities.computeHmacSha256Signature("student:" + String(studentId).trim(), reportKey_());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, "").slice(0, 22);
}

/** ลิงก์รายงานของนักเรียนคนเดียว — ใช้ได้เฉพาะรหัสนี้ ไม่เปิดทางไปข้อมูลคนอื่น */
function studentReportUrl_(studentId) {
  return ScriptApp.getService().getUrl() + "?report=student&id=" + encodeURIComponent(studentId) +
    "&sig=" + studentSig_(studentId);
}

function isStaffRequest_(e) {
  const key = reportKey_();
  const path = String((e && e.pathInfo) || "");
  const p = (e && e.parameter) || {};
  return path === "k/" + key || String(p.key || "") === key;
}

function isOwnStudentReport_(p, action) {
  if (action !== "student" && action !== "downloadStudentReport") return false;
  const id = String(p.id || p.studentId || "").trim();
  return !!id && !!p.sig && String(p.sig) === studentSig_(id);
}

function isAllowedTelegramChat_(chatId) {
  const allowed = String(PropertiesService.getScriptProperties().getProperty("TELEGRAM_CHAT_ID") || "").trim();
  return !!allowed && String(chatId) === allowed;
}

function denyHtml_() {
  return HtmlService.createHtmlOutput(
    '<body style="font-family:sans-serif;padding:32px;line-height:1.7;background:#0B2A1D;color:#F3EBD3">' +
    '<h2 style="color:#E5B65A">🔒 ไม่มีสิทธิ์เข้าถึงข้อมูลนี้</h2>' +
    '<p>ข้อมูลผลประเมินเปิดได้เฉพาะจากปุ่มในกลุ่มผู้ดูแล หรือจากลิงก์ส่วนตัวที่ระบบส่งให้นักเรียนเท่านั้น</p>' +
    '<p>นักเรียนที่ต้องการทำแบบประเมิน: เปิดผ่าน LINE OA ของวิทยาลัย</p></body>'
  ).setTitle("ไม่มีสิทธิ์เข้าถึง · ระบบดูแลใจ");
}

/** ใช้ใน editor: ดูลิงก์ผู้ดูแลชุดใหม่ (แสดงใน log ของ editor เท่านั้น) */
function showStaffLinks() {
  const u = secureApiUrl_();
  Logger.log("รายงานรวม 7 วัน: " + u + "?report=downloadReport&days=7");
  Logger.log("รายชื่อที่ยังไม่ทำ: " + u + "?action=missingStudents");
  Logger.log("รายงาน ST-5: " + u + "?action=st5Report");
}
