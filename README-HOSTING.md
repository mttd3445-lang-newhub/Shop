# STAR Bot — Host Ready

แพ็กนี้เตรียมสำหรับนำไปขึ้นโฮสต์ได้ทันที โดยคงระบบ Discord Shop/เติมเงินเดิม และระบบ STAR Key 1 Key = 1 เครื่อง

## สิ่งที่ต้องตั้งค่า

1. สร้าง Discord Bot ใหม่หรือ Reset Token เดิมที่เคยเปิดเผย
2. ใส่ Token ใน Environment Variable:
   `DISCORD_TOKEN`
3. ค่า ID ต่าง ๆ ของร้านยังอยู่ใน `config.json`
4. อย่าลบโฟลเดอร์ `data/` เพราะเป็นข้อมูลเครดิต ออเดอร์ สินค้า และคีย์

## Docker

```bash
docker compose up -d --build
```

ตรวจ API:

```bash
curl http://127.0.0.1:8787/health
```

ควรได้:

```json
{"ok":true}
```

## Host ที่ใช้ Docker

ใช้ `Dockerfile` เป็นตัวเริ่มต้น และตั้ง `DISCORD_TOKEN` เป็น Secret/Environment Variable ของโฮสต์

โฮสต์ที่กำหนด `PORT` ให้เองจะถูกใช้โดย Key API อัตโนมัติ

## ระบบ Key

- `/genkey 30d` สร้างคีย์ 30 วัน
- คีย์ยังไม่เริ่มนับเวลาจนกว่าจะ Activate ครั้งแรก
- Activate ครั้งแรกจะผูก `machineId`
- เครื่องอื่นใช้คีย์เดิมไม่ได้
- `/checkkey <key>` ตรวจสถานะ
- `/revoke <key>` ยกเลิก
- `/extendkey <key> 30d` เพิ่มอายุ

## สำคัญ

ห้าม commit หรือส่งต่อ `.env` ที่มี Discord Token จริง
