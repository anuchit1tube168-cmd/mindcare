/* ==========================================================
 * 16-AI — Gemini ช่วยงาน ผปค. (ไม่คุยกับนักเรียนโดยตรง ไม่ใช้ตัดสินระดับความเสี่ยง)
 *
 *  1) สรุปภาพรวมรายสัปดาห์ → Telegram   (ส่งเฉพาะตัวเลขรวมรายชั้นปี ไม่มีชื่อ/รหัส/คะแนนรายคน)
 *  2) ร่างข้อความทักนักเรียนที่กดขอคุย → Telegram ให้ ผปค. แก้ก่อนส่งเอง
 *  3) คัดกรองข้อความขอคุย: ด่านแรกเป็นกฎคำสำคัญ (ทำทันที ไม่พึ่ง AI)
 *     ด่านสองเป็น AI อ่านข้อความที่ตัดข้อมูลระบุตัวตนแล้ว (ทำในคิว ภายใน ~1 นาที)
 *
 * ความเป็นส่วนตัว:
 *  - ใช้ได้เฉพาะ Gemini API แบบเสียเงิน (เปิด billing) — รุ่นฟรี Google นำข้อมูลไปพัฒนาและมีคนอ่านได้
 *  - ก่อนส่งข้อความนักเรียนเข้า AI ตัดเลขรหัส เบอร์โทร อีเมล ลิงก์ LINE ID และชื่อหลังคำนำหน้าออก
 *  - ตัวเลขรวมที่น้อยกว่า 3 แสดงเป็น "1-2" กันระบุตัวคนในกลุ่มเล็ก
 *
 * ตั้งค่า (Script Properties): GEMINI_API_KEY (จำเป็น), GEMINI_MODEL (ไม่บังคับ), AI_ENABLED=off เพื่อปิดทั้งหมด
 * ติดตั้ง: รัน installAiTriggers() หนึ่งครั้ง
 * ========================================================== */

// รุ่นราคาถูก (Flash-Lite) ก่อน — งานนี้ไม่ต้องใช้รุ่นใหญ่
const AI_MODELS_FALLBACK = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"];
// เพดานต่อเดือน (ห้ามเกิน): ถึงเพดานแล้วหยุดเรียก AI จนถึงเดือนถัดไป — งานหลักยังทำงานปกติ
// 150,000 token ≈ ไม่เกินราว 1 ดอลลาร์ แม้คิดราคารุ่นที่แพงที่สุดในรายการ (ปรับได้ที่ AI_MONTHLY_TOKEN_LIMIT)
const AI_DEFAULT_MONTHLY_TOKENS = 150000;
const AI_DEFAULT_MONTHLY_CALLS = 400;
const AI_QUEUE_SHEET = "AiQueue";

// ถ้อยคำเสี่ยง (ด่านแรก ทำงานแม้ AI ล่ม) — ตรวจแบบตัดช่องว่างแล้ว
const DANGER_PATTERNS = [
  /อยากตาย/, /ไม่อยากอยู่/, /ไม่อยากมีชีวิต/, /ฆ่าตัว/, /จบชีวิต/, /ตายๆไป/, /ตายไปซะ/,
  /ทำร้ายตัวเอง/, /กรีด/, /กินยาเกิน/, /กินยาตาย/, /กระโดดตึก/, /แขวนคอ/, /ลาก่อนทุกคน/,
  /suicide/i, /killmyself/i, /wanttodie/i,
];

function aiEnabled_() {
  const p = PropertiesService.getScriptProperties();
  return !!p.getProperty("GEMINI_API_KEY") && String(p.getProperty("AI_ENABLED") || "").toLowerCase() !== "off";
}

/** ด่านแรก: กฎคำสำคัญ — คืน true ถ้าพบถ้อยคำเสี่ยง */
function hasDangerWords_(text) {
  const t = String(text || "").replace(/\s+/g, "");
  return !!t && DANGER_PATTERNS.some(function (re) { return re.test(t); });
}

/** ตัดข้อมูลระบุตัวตนก่อนส่งออกนอกระบบ */
function redactPII_(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "[ลิงก์]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[อีเมล]")
    .replace(/\bU[0-9a-f]{32}\b/gi, "[LINE-ID]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[ตัวเลข]")
    .replace(/\d{5,}/g, "[ตัวเลข]")
    .replace(/(นพอ\.|น\.ส\.|นางสาว|นาย|นาง|ด\.ต\.|จ\.อ\.|ร\.ต\.|ร\.ท\.|ร\.อ\.|น\.ต\.|น\.ท\.|น\.อ\.|อาจารย์|ครู|พี่|น้อง)\s*[ก-๙A-Za-z]+/g, "$1[ชื่อ]")
    .slice(0, 400);
}

/** เรียก Gemini — คืนข้อความ หรือ null ถ้าล้มเหลว (ไม่ throw เพื่อไม่ให้กระทบงานหลัก) */
function geminiGenerate_(prompt, opts) {
  opts = opts || {};
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("GEMINI_API_KEY");
  if (!key) return null;
  if (!aiBudgetAllows_()) return null;
  const models = [props.getProperty("GEMINI_MODEL")].concat(AI_MODELS_FALLBACK).filter(Boolean);
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature == null ? 0.4 : opts.temperature,
      maxOutputTokens: opts.maxTokens || 800,
    },
  };
  if (opts.json) body.generationConfig.responseMimeType = "application/json";
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  for (let i = 0; i < models.length; i++) {
    try {
      const res = UrlFetchApp.fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(models[i]) + ":generateContent", {
          method: "post", contentType: "application/json", muteHttpExceptions: true,
          headers: { "x-goog-api-key": key },
          payload: JSON.stringify(body),
        });
      const code = res.getResponseCode();
      if (code === 404) continue; // รุ่นนี้ไม่มี/เลิกให้บริการ → ลองรุ่นถัดไป
      if (code !== 200) {
        logError("geminiGenerate_", "HTTP " + code + " " + res.getContentText().slice(0, 300), models[i]);
        return null;
      }
      const j = JSON.parse(res.getContentText());
      aiBudgetRecord_(j.usageMetadata && j.usageMetadata.totalTokenCount);
      const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      const text = parts ? parts.map(function (p) { return p.text || ""; }).join("").trim() : "";
      return text || null;
    } catch (e) {
      logError("geminiGenerate_", String(e).split(key).join("<KEY>"), models[i]);
      return null;
    }
  }
  logError("geminiGenerate_", "ไม่พบรุ่นที่ใช้ได้", models.join(","));
  return null;
}

const AI_SYSTEM_STAFF =
  "คุณเป็นผู้ช่วยของหน่วยปกครอง (ผปค.) วิทยาลัยพยาบาลทหารอากาศ ที่ดูแลสุขภาพใจของนักเรียนพยาบาล " +
  "ตอบเป็นภาษาไทย สุภาพ กระชับ ห้ามวินิจฉัยโรค ห้ามแต่งตัวเลขหรือข้อเท็จจริงที่ไม่มีในข้อมูล " +
  "ถ้าข้อมูลไม่พอให้บอกตรงๆ ช่องทางฉุกเฉินคือสายด่วนสุขภาพจิต 1323 และ 1669";

/* ---------------- เพดานค่าใช้จ่ายรายเดือน ---------------- */

function aiMonthKey_() { return "AI_USAGE_" + Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMM"); }

function aiUsage_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(aiMonthKey_()) || "{}"); }
  catch (e) { return {}; }
}

function aiBudgetAllows_() {
  const p = PropertiesService.getScriptProperties();
  const tokLimit = Number(p.getProperty("AI_MONTHLY_TOKEN_LIMIT")) || AI_DEFAULT_MONTHLY_TOKENS;
  const callLimit = Number(p.getProperty("AI_MONTHLY_CALL_LIMIT")) || AI_DEFAULT_MONTHLY_CALLS;
  const u = aiUsage_();
  const ok = (u.tokens || 0) < tokLimit && (u.calls || 0) < callLimit;
  if (!ok && !u.notified) {
    u.notified = true;
    p.setProperty(aiMonthKey_(), JSON.stringify(u));
    try {
      pushTelegramMessage("⚠️ AI ของระบบดูแลใจใช้ครบเพดานเดือนนี้แล้ว (" + (u.tokens || 0) + " token / " + (u.calls || 0) +
        " ครั้ง) — หยุดใช้ AI อัตโนมัติจนถึงต้นเดือนหน้า\nงานหลักยังทำงานปกติ: แจ้งเตือน, ขอคุย, ตรวจถ้อยคำเสี่ยง");
    } catch (e) {}
  }
  return ok;
}

function aiBudgetRecord_(tokens) {
  const lock = LockService.getScriptLock();
  const got = lock.tryLock(3000);
  try {
    const p = PropertiesService.getScriptProperties();
    const u = aiUsage_();
    u.calls = (u.calls || 0) + 1;
    u.tokens = (u.tokens || 0) + (Number(tokens) || 1500); // ไม่รู้จำนวนจริง → คิดเผื่อไว้ก่อน
    p.setProperty(aiMonthKey_(), JSON.stringify(u));
  } finally { if (got) lock.releaseLock(); }
}

/** ดูยอดใช้ AI เดือนนี้ (รันใน editor) */
function showAiUsage() { Logger.log(aiMonthKey_() + " " + JSON.stringify(aiUsage_())); }

/* ---------------- 1) สรุปรายสัปดาห์ ---------------- */

function maskCount_(n) { return n === 0 ? 0 : (n < 3 ? "1-2" : n); }

/** สร้างตัวเลขรวม 7 วันล่าสุดเทียบ 7 วันก่อนหน้า แยกชั้นปี (ไม่มีข้อมูลรายคน) */
function weeklyAggregates_() {
  const now = Date.now(), d7 = 7 * 86400000;
  const roster = rosterMap();
  const rows = loadAssessments();
  const blank = function () { return { total: 0, RED: 0, ORANGE: 0, YELLOW: 0, GREEN: 0, st5sum: 0, st5n: 0 }; };
  const cur = {}, prev = {};
  rows.forEach(function (a) {
    const t = a.ts instanceof Date ? a.ts.getTime() : new Date(a.ts).getTime();
    if (!t || now - t > 2 * d7) return;
    const bucket = now - t <= d7 ? cur : prev;
    const r = roster[a.studentId];
    const yr = (r && r.year) ? String(r.year) : "ไม่ระบุชั้นปี";
    bucket[yr] = bucket[yr] || blank();
    const b = bucket[yr];
    b.total++;
    const lv = String(a.level || "").toUpperCase();
    if (b[lv] !== undefined) b[lv]++;
    if (typeof a.st5 === "number" || (a.st5 !== "" && !isNaN(Number(a.st5)))) { b.st5sum += Number(a.st5); b.st5n++; }
  });
  const shape = function (bk) {
    const out = {};
    Object.keys(bk).sort().forEach(function (y) {
      const b = bk[y];
      out[y] = {
        ทำแบบประเมิน: maskCount_(b.total), RED: maskCount_(b.RED), ORANGE: maskCount_(b.ORANGE),
        YELLOW: maskCount_(b.YELLOW), GREEN: maskCount_(b.GREEN),
        ST5เฉลี่ย: b.st5n >= 3 ? Math.round(b.st5sum / b.st5n * 10) / 10 : "ข้อมูลน้อย",
      };
    });
    return out;
  };
  // จำนวนคำขอคุย 7 วันล่าสุด
  let talks = 0;
  try {
    const al = getSheet(SHEETS.ALERTS).getDataRange().getValues();
    for (let i = 1; i < al.length; i++) {
      const t = al[i][0] instanceof Date ? al[i][0].getTime() : 0;
      if (al[i][4] === "TALK" && t && now - t <= d7 && String(al[i][3]).indexOf("TEST") !== 0) talks++;
    }
  } catch (e) { /* ไม่มีชีตก็ข้าม */ }
  let open = {};
  try { open = getSummary().openAlerts || {}; } catch (e) {}
  return { สัปดาห์นี้: shape(cur), สัปดาห์ก่อน: shape(prev), คำขอคุยสัปดาห์นี้: maskCount_(talks), เคสค้างทั้งหมด: open };
}

function aiWeeklySummary() {
  const agg = weeklyAggregates_();
  const header = "🧭 สรุปภาพรวมระบบดูแลใจ (7 วันล่าสุด)\n" +
    Utilities.formatDate(new Date(), "Asia/Bangkok", "dd/MM/yyyy") + "\n";
  let body = null;
  if (aiEnabled_()) {
    body = geminiGenerate_(
      "ข้อมูลรวมรายชั้นปี (ตัวเลข 1-2 ถูกปิดไว้เพื่อความเป็นส่วนตัว):\n" + JSON.stringify(agg) +
      "\n\nเขียนสรุปให้ ผปค. ไม่เกิน 10 บรรทัด: (1) ภาพรวมเทียบสัปดาห์ก่อน (2) ชั้นปีที่ควรให้ความสนใจและเหตุผลจากตัวเลข " +
      "(3) ข้อเสนอแนะเชิงปฏิบัติ 2-3 ข้อสำหรับสัปดาห์นี้ ห้ามสรุปเกินกว่าตัวเลขที่มี ใช้ bullet สั้นๆ",
      { system: AI_SYSTEM_STAFF, temperature: 0.3, maxTokens: 700 });
  }
  if (!body) body = "(AI ไม่พร้อมใช้งาน — แสดงตัวเลขรวมแทน)\n" + JSON.stringify(agg, null, 1);
  pushTelegramMessage(header + body + "\n\n🤖 ร่างโดย AI จากตัวเลขรวมเท่านั้น โปรดตรวจสอบก่อนนำไปใช้");
}

/* ---------------- 2) + 3) คิวขอคุย: ร่างข้อความ + AI คัดกรองด่านสอง ---------------- */

function aiQueueSheet_() {
  const ss = getSheet(SHEETS.ALERTS).getParent();
  let sh = ss.getSheetByName(AI_QUEUE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AI_QUEUE_SHEET);
    sh.appendRow(["createdAt", "ticketId", "urgent", "contact", "source", "noteRedacted", "keywordFlag", "status", "aiRisk", "doneAt"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** เรียกจาก handleTalkRequest — ใส่คิวเท่านั้น (เร็ว) ไม่รอ AI */
function enqueueTalkForAi_(ticketId, urgent, contact, source, note, keywordFlag) {
  if (!aiEnabled_()) return;
  try {
    aiQueueSheet_().appendRow([new Date(), ticketId, urgent, contact, source, redactPII_(note), keywordFlag, "pending", "", ""]);
    CacheService.getScriptCache().put("aiq_pending", "1", 3600);
  } catch (e) { logError("enqueueTalkForAi_", e, ticketId); }
}

/** trigger ทุก 1 นาที — ถ้าไม่มีงานค้าง จบทันทีโดยไม่เปิดชีต */
function aiProcessQueue() {
  const cache = CacheService.getScriptCache();
  if (!cache.get("aiq_pending") || !aiEnabled_()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const sh = aiQueueSheet_();
    const vals = sh.getDataRange().getValues();
    let left = 0;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i][7] !== "pending") continue;
      if (left >= 5) { left++; continue; } // ทำทีละไม่เกิน 5 เรื่องต่อรอบ กันเกินเวลา
      left++;
      const r = vals[i];
      const ticketId = r[1], urgent = r[2] === true, contact = r[3], source = r[4], note = r[5], kw = r[6] === true;
      const out = geminiGenerate_(
        "นักเรียนกดปุ่ม 'อยากคุยกับ ผปค.' ในระบบดูแลใจ\n" +
        "ความด่วนที่นักเรียนเลือก: " + (urgent ? "ด่วน" : "ไม่ด่วน") + "\nช่องทางที่สะดวก: " + contact +
        "\nกดจาก: " + source + "\nข้อความของนักเรียน (ตัดข้อมูลระบุตัวตนแล้ว): " + (note || "(ไม่ได้พิมพ์)") +
        "\n\nตอบเป็น JSON เท่านั้น: {\"risk\":\"ปกติ|ควรติดตาม|เร่งด่วน\",\"reason\":\"เหตุผลสั้นๆ 1 ประโยค\"," +
        "\"draft\":\"ร่างข้อความ LINE ที่ ผปค. ใช้ทักนักเรียน 2-4 ประโยค อบอุ่น ไม่ตัดสิน ชวนนัดคุย ไม่ถามรายละเอียดอ่อนไหวผ่านแชท ไม่ใส่ชื่อ\"}" +
        "\nถ้าข้อความสื่อถึงการทำร้ายตนเองหรืออันตรายต่อชีวิต ให้ risk เป็น เร่งด่วน เสมอ",
        { system: AI_SYSTEM_STAFF, temperature: 0.3, maxTokens: 500, json: true });
      let parsed = null;
      try { parsed = out ? JSON.parse(out) : null; } catch (e) { parsed = null; }
      const risk = parsed && parsed.risk ? String(parsed.risk) : "";
      if (parsed) {
        const alarm = risk === "เร่งด่วน" && !kw && !urgent
          ? "🚨 AI ประเมินว่าข้อความอาจเร่งด่วน (นักเรียนเลือก 'ไม่ด่วน') — โปรดติดต่อเร็วกว่ากำหนด\n" : "";
        pushTelegramMessage(
          alarm + "✍️ ร่างข้อความทักนักเรียน — เลขเรื่อง " + ticketId + "\n" +
          "AI ประเมินข้อความ: " + (risk || "-") + (parsed.reason ? " · " + String(parsed.reason).slice(0, 160) : "") + "\n" +
          "--------------------\n" + String(parsed.draft || "").slice(0, 900) + "\n--------------------\n" +
          "🤖 ร่างโดย AI — ผปค. โปรดแก้ให้เหมาะกับนักเรียนก่อนส่ง");
      }
      sh.getRange(i + 1, 8, 1, 3).setValues([[parsed ? "done" : "failed", risk, new Date()]]);
    }
    if (left <= 5) cache.remove("aiq_pending");
  } catch (e) {
    logError("aiProcessQueue", e, "");
  } finally {
    lock.releaseLock();
  }
}

/** ติดตั้ง trigger: คิวทุก 1 นาที + สรุปทุกวันจันทร์ 07:00 (ไม่สร้างซ้ำ) */
function installAiTriggers() {
  const have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf("aiProcessQueue") < 0) ScriptApp.newTrigger("aiProcessQueue").timeBased().everyMinutes(1).create();
  if (have.indexOf("aiWeeklySummary") < 0) {
    ScriptApp.newTrigger("aiWeeklySummary").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).inTimezone("Asia/Bangkok").create();
  }
  Logger.log("ติดตั้งแล้ว: " + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(", "));
}

/** ทดสอบ: เรียก Gemini ด้วยข้อความไม่มีข้อมูลนักเรียน */
function testGemini() {
  Logger.log("AI enabled: " + aiEnabled_());
  Logger.log(geminiGenerate_("ตอบคำว่า 'พร้อมใช้งาน' คำเดียว", { maxTokens: 20, temperature: 0 }));
  Logger.log("redact: " + redactPII_("นพอ.สมใจ เบอร์ 081-234-5678 รหัส 6903955 อยากคุยค่ะ"));
  Logger.log("danger: " + hasDangerWords_("ช่วงนี้ไม่อยาก อยู่แล้ว") + " / " + hasDangerWords_("อยากคุยเรื่องเรียน"));
}
