/* ==========================================================
 * ทดสอบอัตโนมัติ end-to-end — รันครั้งเดียวใน editor เพื่อตรวจทั้งระบบ
 * เลือกฟังก์ชัน runSelfTest จาก dropdown แล้วกด Run
 * จะจำลองการส่งข้อมูล 3 เคส (เขียว/ส้ม/แดง) ตรวจว่าไหลเข้าชีตถูก
 * สร้าง alert ถูก แล้วลบข้อมูลทดสอบทิ้ง คืนผลว่าผ่าน/ไม่ผ่านทุกจุด
 * ผลลัพธ์ดูได้ที่ Execution log (View > Logs)
 * ========================================================== */
function runSelfTest() {
  const results = [];
  const pass = (name) => results.push("✅ " + name);
  const fail = (name, detail) => results.push("❌ " + name + " — " + detail);

  // 0) ตรวจว่าชีตครบ
  const need = [SHEETS.ASSESSMENTS, SHEETS.ALERTS, SHEETS.BINDINGS, SHEETS.ROSTER,
                SHEETS.TEACHERS, SHEETS.REPORTS, SHEETS.ERRORS];
  need.forEach(function (n) {
    try { getSheet(n); pass("มีชีต " + n); }
    catch (e) { fail("ชีต " + n, "ไม่พบ — รัน setup() ก่อน"); }
  });

  // 1) ทดสอบส่งข้อมูล 3 เคส (ใช้รหัสทดสอบ ไม่ชนของจริง)
  const cases = [
    { name: "เคสเขียว (ปกติ)", d: { studentId: "TEST9001", st5Score: 3, q2Score: 0,
      cameraUsed: false }, expectRisk: "GREEN", expectAlert: false },
    { name: "เคสส้ม (9Q สูง)", d: { studentId: "TEST9002", st5Score: 9, q2Score: 1,
      q9Score: 15, q9Item9: 1, q8Score: 11, cameraUsed: true, behaviorIndex: 61,
      conflictFlag: true }, expectRisk: "ORANGE", expectAlert: true },
    { name: "เคสแดง (8Q≥17)", d: { studentId: "TEST9003", st5Score: 12, q2Score: 1,
      q9Score: 20, q9Item9: 1, q8Score: 18, cameraUsed: false }, expectRisk: "RED",
      expectAlert: true },
  ];
  const testIds = [];
  cases.forEach(function (c) {
    try {
      const res = handleSubmit(c.d);
      testIds.push(res.assessmentId);
      if (res.riskLevel === c.expectRisk) pass(c.name + " → ระดับ " + res.riskLevel + " ถูกต้อง");
      else fail(c.name, "ได้ระดับ " + res.riskLevel + " ควรเป็น " + c.expectRisk);
      if (!!res.alertId === c.expectAlert) pass(c.name + " → การสร้าง alert ถูกต้อง");
      else fail(c.name, "alert " + (res.alertId ? "ถูกสร้าง" : "ไม่ถูกสร้าง") + " ไม่ตรงที่คาด");
    } catch (e) {
      fail(c.name, String(e));
    }
  });

  // 2) ตรวจว่าข้อมูลเข้าชีต Assessments จริง
  try {
    const rows = getSheet(SHEETS.ASSESSMENTS).getDataRange().getValues();
    const found = rows.filter(function (r) { return String(r[2]).indexOf("TEST900") === 0; });
    if (found.length === cases.length) pass("ข้อมูลเข้าชีต Assessments ครบ " + found.length + " เคส");
    else fail("ข้อมูลในชีต", "พบ " + found.length + " ควรเป็น " + cases.length);
  } catch (e) { fail("อ่านชีต Assessments", String(e)); }

  // 3) ตรวจการตั้งค่า (เตือนถ้ายังไม่ครบ ไม่ถือว่า fail)
  const props = PropertiesService.getScriptProperties();
  results.push(props.getProperty("LINE_CHANNEL_ACCESS_TOKEN") ? "✅ ตั้ง LINE token แล้ว" : "⚠️ ยังไม่ตั้ง LINE_CHANNEL_ACCESS_TOKEN");
  results.push(props.getProperty("DASHBOARD_TOKEN") ? "✅ ตั้ง DASHBOARD_TOKEN แล้ว" : "⚠️ ยังไม่ตั้ง DASHBOARD_TOKEN");
  results.push((props.getProperty("TELEGRAM_BOT_TOKEN") && props.getProperty("TELEGRAM_CHAT_ID")) ? "✅ ตั้ง Telegram แล้ว" : "⚠️ ยังไม่ตั้ง Telegram (ข้ามได้ถ้าไม่ใช้)");
  const roster = getSheet(SHEETS.ROSTER).getLastRow() - 1;
  results.push(roster > 0 ? ("✅ มีรายชื่อในทะเบียน Roster " + roster + " คน") : "⚠️ ยังไม่มีรายชื่อในชีต Roster (นักเรียนจะผูกบัญชีไม่ได้)");

  // 4) ล้างข้อมูลทดสอบทิ้ง
  cleanupTestData(testIds);
  results.push("🧹 ลบข้อมูลทดสอบเรียบร้อย");

  const summary = "\n===== ผลการทดสอบระบบดูแลใจ =====\n" + results.join("\n") +
    "\n================================\n" +
    (results.some(function (r) { return r.indexOf("❌") === 0; })
      ? "⚠️ มีบางจุดไม่ผ่าน โปรดแก้ตามรายการข้างบน"
      : "🎉 ผ่านทุกจุดหลัก ระบบพร้อมทำงาน");
  Logger.log(summary);
  return summary;
}

/** ลบแถวทดสอบ (studentId ขึ้นต้น TEST900) ออกจาก Assessments และ Alerts */
function cleanupTestData(testIds) {
  [SHEETS.ASSESSMENTS, SHEETS.ALERTS].forEach(function (name) {
    const sh = getSheet(name);
    const rows = sh.getDataRange().getValues();
    // ลบจากล่างขึ้นบนเพื่อไม่ให้ index เพี้ยน
    for (let i = rows.length - 1; i >= 1; i--) {
      const joined = rows[i].join("|");
      if (joined.indexOf("TEST900") !== -1) sh.deleteRow(i + 1);
    }
  });
}
