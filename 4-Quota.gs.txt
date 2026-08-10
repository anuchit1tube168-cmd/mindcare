/* ==========================================================
 * ระบบส่งแจ้งเตือน 2 ช่องทาง + ป้องกันโควตา LINE หมด
 *
 * หลักการ (สำคัญต่อความปลอดภัยของนักเรียน):
 * 1. Telegram ส่งเสมอทุกกรณี — ไม่มีเพดานข้อความ ถือเป็นช่องทางหลักที่เชื่อถือได้
 * 2. LINE มีโควตาจำกัด (แพ็กเกจฟรี 300 ข้อความ/เดือน) จึงต้องสงวนไว้ให้เคสสำคัญ
 *    - RED    ส่งตราบใดที่ยังมีโควตาเหลือ (เคสเสี่ยงต่อชีวิต ห้ามพลาด)
 *    - ORANGE ส่งเมื่อโควตาเหลือมากกว่าค่ากันชน
 *    - รายงาน/เตือนซ้ำ ส่งเมื่อเหลือมากกว่ากันชน 2 เท่า
 * 3. ถ้าโควตาไม่พอ จะไม่เงียบหาย — บันทึก ErrorLog และแจ้งทาง Telegram ทันที
 * ========================================================== */

// โควตา LINE ที่กันไว้ให้เคสแดงโดยเฉพาะ (ปรับได้ตามแพ็กเกจที่ใช้)
const LINE_QUOTA_RESERVE = 30;

/**
 * ดึงจำนวนข้อความ LINE ที่ยังส่งได้ในเดือนนี้
 * cache 30 นาที เพื่อไม่เรียก API ถี่เกินจำเป็น
 * คืน Infinity ถ้าเป็นแพ็กเกจไม่จำกัด, คืน null ถ้าเช็คไม่ได้
 */
function getLineQuotaRemaining(token) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("lineQuotaRemaining");
  if (cached !== null) return cached === "INF" ? Infinity : Number(cached);

  try {
    const opt = { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true };
    const qRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/quota", opt);
    if (qRes.getResponseCode() !== 200) {
      logError("getLineQuotaRemaining", "HTTP " + qRes.getResponseCode() + " " + qRes.getContentText(), "");
      return null;
    }
    const quota = JSON.parse(qRes.getContentText());
    // type = "none" คือไม่จำกัดจำนวน
    if (quota.type === "none") {
      cache.put("lineQuotaRemaining", "INF", 1800);
      return Infinity;
    }

    const cRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/quota/consumption", opt);
    if (cRes.getResponseCode() !== 200) return null;
    const used = JSON.parse(cRes.getContentText()).totalUsage || 0;
    const remaining = Math.max(0, Number(quota.value || 0) - Number(used));

    cache.put("lineQuotaRemaining", String(remaining), 1800);
    return remaining;
  } catch (err) {
    logError("getLineQuotaRemaining", err, "");
    return null;
  }
}

/** โควตาที่ต้องเหลือขั้นต่ำ จึงจะยอมส่งข้อความประเภทนั้นทาง LINE */
function lineQuotaThreshold(kind) {
  if (kind === "RED") return 1;                        // เหลือใบสุดท้ายก็ต้องส่ง
  if (kind === "ORANGE") return LINE_QUOTA_RESERVE;    // สงวนที่ว่างให้เคสแดง
  return LINE_QUOTA_RESERVE * 2;                       // รายงาน/เตือนซ้ำ ยอมงดก่อน
}

/**
 * ส่งแจ้งเตือนตามลำดับความสำคัญ — จุดเดียวที่ทุกการแจ้งเตือนต้องผ่าน
 * @param {string} text ข้อความ
 * @param {string} kind "RED" | "ORANGE" | "REPORT"
 * @return {Object} สรุปว่าส่งช่องไหนสำเร็จ
 */
function sendAlert(text, kind) {
  const result = { telegram: false, line: 0, lineSkipped: false, quota: null };

  // 1) Telegram ก่อนเสมอ — ไม่มีเพดาน จึงเป็นช่องทางที่ไว้ใจได้ที่สุด
  result.telegram = pushTelegramMessage(text);

  // 2) LINE ตามโควตาที่เหลือ
  const token = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) return result;

  const recipients = getTeacherLineIds();
  if (recipients.length === 0) {
    logError("sendAlert", "ไม่มี lineUserId ที่ active ในชีต Teachers", kind);
    return result;
  }

  const remaining = getLineQuotaRemaining(token);
  result.quota = remaining;
  const threshold = lineQuotaThreshold(kind);
  let targets = recipients;

  if (remaining !== null && remaining !== Infinity) {
    if (remaining < threshold) {
      // โควตาต่ำกว่าเกณฑ์ของประเภทนี้ → งดส่ง LINE แต่ไม่เงียบหาย
      result.lineSkipped = true;
      const warn =
        "⚠️ โควตาข้อความ LINE ไม่พอ (เหลือ " + remaining + " ข้อความ)\n" +
        "ระบบงดส่งแจ้งเตือนระดับ " + kind + " ทาง LINE ในครั้งนี้\n" +
        "ข้อความยังส่งถึงท่านทาง Telegram ตามปกติ\n" +
        "โปรดพิจารณาอัปเกรดแพ็กเกจ LINE Official Account";
      logError("sendAlert.quotaLow", "เหลือ " + remaining + " ต้องการ " + recipients.length, kind);
      pushTelegramMessage(warn);
      return result;
    }
    if (remaining < recipients.length) {
      // โควตาพอส่งได้บางส่วน — เคสสำคัญต้องถึงมือใครก็ได้ก่อน ดีกว่าไม่ถึงเลย
      targets = recipients.slice(0, remaining);
      result.linePartial = true;
      logError("sendAlert.quotaPartial",
        "ส่งได้ " + remaining + " จาก " + recipients.length + " คน", kind);
      pushTelegramMessage(
        "⚠️ โควตา LINE เหลือ " + remaining + " ข้อความ ส่งถึงอาจารย์ได้ไม่ครบทุกคน\n" +
        "ผู้ที่ไม่ได้รับทาง LINE ยังได้รับทาง Telegram");
    }
  }

  targets.forEach(function (userId) {
    if (pushLineMessage(token, userId, text)) result.line++;
  });

  // ใช้โควตาไปแล้วเท่าไร ปรับ cache ให้ตรงความจริงโดยไม่ต้องเรียก API ซ้ำ
  if (remaining !== null && remaining !== Infinity) {
    CacheService.getScriptCache()
      .put("lineQuotaRemaining", String(Math.max(0, remaining - result.line)), 1800);
  }
  return result;
}

/** ดูสถานะโควตา LINE จากเมนูในชีต (ใช้ตรวจก่อนถึงสิ้นเดือน) */
function menuCheckQuota() {
  const ui = SpreadsheetApp.getUi();
  const token = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) {
    ui.alert("ยังไม่ได้ตั้งค่า", "ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน Script Properties", ui.ButtonSet.OK);
    return;
  }
  CacheService.getScriptCache().remove("lineQuotaRemaining"); // บังคับดึงค่าจริง
  const remaining = getLineQuotaRemaining(token);
  const teachers = getTeacherLineIds().length;

  let msg;
  if (remaining === null) msg = "ตรวจโควตาไม่สำเร็จ — ดูรายละเอียดในชีต ErrorLog";
  else if (remaining === Infinity) msg = "แพ็กเกจนี้ไม่จำกัดจำนวนข้อความ";
  else {
    msg = "ข้อความ LINE ที่ยังส่งได้เดือนนี้: " + remaining + "\n" +
      "อาจารย์ที่รับแจ้งเตือน: " + teachers + " คน\n" +
      "แจ้งเตือนได้อีกประมาณ " + (teachers ? Math.floor(remaining / teachers) : "-") + " เคส\n\n" +
      (remaining < LINE_QUOTA_RESERVE
        ? "⚠️ โควตาต่ำกว่าค่ากันชน ระบบจะส่งเฉพาะเคสแดงทาง LINE\nเคสอื่นยังส่งทาง Telegram ปกติ"
        : "สถานะปกติ");
  }
  ui.alert("โควตาข้อความ LINE", msg, ui.ButtonSet.OK);
}
