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

## 15-Security (v64, 23 พ.ย. 2569) — กันข้อมูลไหลออก
ใส่ไว้ท้าย `1a-Core.gs` แล้ว deploy เป็นเวอร์ชัน 64 พร้อมแก้ 6 จุด:
- `doGet`: ทุกคำสั่งที่ไม่ใช่หน้าเว็บหลักต้องมีกุญแจผู้ดูแล (`/exec/k/<REPORT_KEY>`) หรือเป็นลิงก์รายงานของนักเรียนเองที่มีลายเซ็น (`&sig=`)
- ปุ่มใน Telegram (`notifyTeachers`, คำสั่งในกลุ่ม) ใช้ `secureApiUrl_()` จึงพกกุญแจไปเอง
- ลิงก์รายงานที่ส่งให้นักเรียนทาง LINE ใช้ `studentReportUrl_(id)` เปิดได้เฉพาะของตัวเอง
- บอท Telegram ตอบเฉพาะกลุ่ม `TELEGRAM_CHAT_ID` (กัน update ปลอม)
- `doPost setToken` ต้องมี `key` = REPORT_KEY
- `verifyStudent` ไม่ส่งชื่อเต็ม (ส่งเฉพาะชื่อย่อ) กันไล่เดารหัสดึงทะเบียน

ถ้าสงสัยว่ากุญแจรั่ว: ลบ `REPORT_KEY` ใน Script Properties → ระบบสร้างใหม่อัตโนมัติ ลิงก์เก่าทั้งหมดใช้ไม่ได้ทันที
