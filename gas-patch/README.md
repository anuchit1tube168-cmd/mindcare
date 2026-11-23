# Backend patch — ขอคุยกับ ผปค. + กันบันทึกซ้ำ

โปรเจกต์ Apps Script: **RTAFNC ONE — LIFF Services** (deployment `AKfycbwPAuG…`)
ทำ **ก่อน** merge PR นี้ (ถ้า merge ก่อน ปุ่มขอคุยจะขึ้นข้อความให้โทร 1323 แทน แต่การบันทึกผลยังทำงานปกติ)

1. เพิ่มไฟล์สคริปต์ใหม่ชื่อ `14-TalkRequest` แล้ววางเนื้อหาจาก `14-TalkRequest.gs`
2. ใน `1a-Core.gs` ฟังก์ชัน `doPost` ต่อจากบล็อก `submitAssessment` เพิ่ม:
   ```js
       if (data.action === "requestTalk") {
         return output(handleTalkRequest(data));
       }
   ```
3. ใน `1a-Core.gs` บรรทัดแรกของ `function handleSubmit(d) {` เพิ่ม:
   ```js
     // กันบันทึกซ้ำเมื่อหน้าเว็บส่งซ้ำ (retry หลังเน็ตหลุด) — clientRef เดิมได้ผลเดิม
     const subRef = String(d.clientRef || "").replace(/[^\w-]/g, "").slice(0, 64);
     if (subRef) {
       const prev = CacheService.getScriptCache().get("sub_" + subRef);
       if (prev) return JSON.parse(prev);
     }
   ```
4. ท้าย `handleSubmit` เปลี่ยน `return { ok: true, assessmentId: ..., alertId: alertId };` เป็น:
   ```js
     const submitResult = { ok: true, assessmentId: assessmentId, riskLevel: risk.level, alertId: alertId };
     if (subRef) CacheService.getScriptCache().put("sub_" + subRef, JSON.stringify(submitResult), 21600);
     return submitResult;
   ```
5. บันทึก → เรียกใช้ `testTalkRequest` → ต้องมีแถว `TALK` ใหม่ในชีต Alerts
6. การทำให้ใช้งานได้ → จัดการ → แก้ไข deployment `AKfycbwPAuG…` → เวอร์ชันใหม่ → การทำให้ใช้งานได้ (URL เดิม)
7. ลบแถวทดสอบ `TEST-TALK` ในชีต Alerts

ผปค. จะได้รับแจ้งผ่าน `sendAlert()` ช่องทางเดียวกับแจ้งเตือนเคสเสี่ยง (Telegram → LINE)
ถ้าช่องทางนั้นยังไม่ได้ตั้งค่า เรื่องยังอยู่ในชีต Alerts + dashboard และ `checkOverdueAlerts` เตือนซ้ำเมื่อเกินกำหนด
