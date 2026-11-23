/* ==========================================================
 * 14-TalkRequest.gs — ปุ่ม "อยากคุยกับใครสักคน" ส่งเรื่องถึง ผปค. ทันที
 *
 * ลำดับงาน (บันทึกก่อน แจ้งทีหลัง — ถ้าแจ้งไม่ออก เรื่องก็ยังอยู่ในระบบ):
 *   1) ตรวจ/ทำความสะอาดข้อมูล + กันกดซ้ำ (clientRef / 1 นาที ต่อคน)
 *   2) บันทึกลงชีต Alerts ระดับ "TALK" → ขึ้น dashboard + checkOverdueAlerts เตือนซ้ำให้เองเมื่อเกินกำหนด
 *   3) แจ้งผ่าน sendAlert() ช่องทางเดียวกับเคสเสี่ยง (Telegram ก่อน แล้ว LINE)
 *      ส่งเป็น kind "RED" เพื่อไม่ให้ถูกงดเพราะโควตา LINE ใกล้หมด
 *
 * ความเป็นส่วนตัว: ไม่บันทึกคะแนนแบบประเมินในข้อความนี้ — ผปค. ดูผลได้จาก dashboard ที่ต้องใช้ token
 * ========================================================== */

const TALK_DUE_HOURS = { urgent: 1, normal: 24 };
const TALK_CONTACT_LABEL = { line: "ทัก LINE กลับ", phone: "โทรหา", visit: "มาพบที่ห้อง ผปค." };

function handleTalkRequest(d) {
  const cache = CacheService.getScriptCache();
  const ref = String(d.clientRef || "").replace(/[^\w-]/g, "").slice(0, 64);
  if (ref) {
    const hit = cache.get("talk_" + ref);
    if (hit) return JSON.parse(hit); // ส่งซ้ำจาก retry → ตอบเลขเดิม ไม่สร้างเรื่องใหม่
  }

  let sid = String(d.studentId || "").trim().slice(0, 40);
  if ((!sid || sid === "TEST-001") && d.lineUserId) {
    sid = getStudentIdByLineUserId(d.lineUserId) || ("LINE:" + String(d.lineUserId).slice(0, 10));
  }
  if (!sid) return { ok: false, error: "missing studentId" };

  // กันกดรัวจากคนเดียวกัน — ตอบเรื่องเดิมภายใน 60 วินาที
  const recentKey = "talk_sid_" + Utilities.base64EncodeWebSafe(sid).slice(0, 80);
  const recent = cache.get(recentKey);
  if (recent) return JSON.parse(recent);

  const urgent = d.urgency !== "normal";
  const contact = TALK_CONTACT_LABEL[d.contact] ? d.contact : "line";
  const phone = String(d.phone || "").replace(/[^\d+]/g, "").slice(0, 15);
  // ห้ามใช้ชื่อฟิลด์ "message" — doPost จะเข้าใจว่าเป็น Telegram webhook
  const message = String(d.note || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 300);
  const source = d.source === "care" ? "หน้าดูแลพิเศษ (8Q)" : "หน้าผลประเมิน";
  const who = talkWho_(sid, d.displayName);

  const ticketId = "T" + Date.now() + Math.floor(Math.random() * 1000);
  const due = new Date(Date.now() + (urgent ? TALK_DUE_HOURS.urgent : TALK_DUE_HOURS.normal) * 3600 * 1000);
  const contactText = TALK_CONTACT_LABEL[contact] + (contact === "phone" && phone ? " " + phone : "");
  const reason = "นักเรียนขอคุยกับ ผปค." + (urgent ? " (ด่วน)" : "") + " · ติดต่อ: " + contactText +
    " · จาก: " + source + (message ? " · ข้อความ: " + message : "");

  // 1) บันทึกก่อนเสมอ — คอลัมน์เดียวกับ createAlert()
  getSheet(SHEETS.ALERTS).appendRow([
    new Date(), ticketId, sanitize(d.assessmentId || ""), sanitize(sid), "TALK",
    sanitize(reason), "แจ้งแล้ว", due, "", "", "", 0,
  ]);

  // 2) แจ้ง ผปค.
  let sent = { telegram: false, line: 0 };
  try {
    const text =
      (urgent ? "🆘 นักเรียนขอคุย — ด่วน" : "💬 นักเรียนขอคุย") + "\n" +
      "ระบบดูแลใจ วพอ.พอ.\n" +
      "👤 " + who + "\n" +
      "📞 ติดต่อ: " + contactText + "\n" +
      (message ? "📝 " + message + "\n" : "") +
      "📍 กดจาก: " + source + "\n" +
      "⏱ ติดต่อกลับภายใน: " + Utilities.formatDate(due, "Asia/Bangkok", "dd/MM/yyyy HH:mm") + "\n" +
      "เลขเรื่อง: " + ticketId + "\n" +
      "→ รับเรื่องแล้วโปรดอัปเดตสถานะใน dashboard";
    sent = sendAlert(text, "RED") || sent;
  } catch (e) {
    logError("handleTalkRequest.sendAlert", e, ticketId);
  }

  const result = {
    ok: true, ticketId: ticketId, dueAt: due.toISOString(), urgent: urgent,
    notified: !!(sent.telegram || sent.line > 0),
  };
  if (ref) cache.put("talk_" + ref, JSON.stringify(result), 21600);
  cache.put(recentKey, JSON.stringify(result), 60);
  return result;
}

function talkWho_(sid, displayName) {
  let name = String(displayName || "").trim().slice(0, 60);
  let year = "";
  try {
    const r = typeof rosterMap === "function" ? rosterMap()[sid] : null;
    if (r) { name = r.name || name; year = r.year || ""; }
  } catch (e) { /* ไม่มี roster ก็ใช้ชื่อที่ส่งมา */ }
  return (name || "(ไม่ระบุชื่อ)") + (/^\d{7}$/.test(sid) ? " · " + sid : "") + (year ? " · " + year : "");
}

/** ทดสอบใน editor: ต้องเห็นแถว TALK ใหม่ในชีต Alerts (และข้อความในกลุ่ม ถ้าตั้งค่าช่องแจ้งเตือนไว้) */
function testTalkRequest() {
  const r = handleTalkRequest({ studentId: "TEST-TALK", displayName: "ทดสอบปุ่มขอคุย", urgency: "normal",
    contact: "line", note: "ทดสอบระบบ — ไม่ต้องติดต่อกลับ", clientRef: "test-" + Date.now() });
  Logger.log(JSON.stringify(r));
}
