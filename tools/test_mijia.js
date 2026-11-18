const m = require("../lib/mijia");
(async () => {
  const evs = await m.fetchEvents(Date.now() - 72 * 3600000, Date.now(), 5);
  console.log("events:", evs.length);
  if (evs.length) {
    const u = evs[0];
    console.log("createTime:", u.createTime, "eventType:", u.eventType);
    console.log("details:", (u.eventTypeDetail || []).map(d => d.event).join(","));
    const buf = await m.fetchImage(u.fileId, u.imgStoreId);
    console.log("img bytes:", buf.length, "magic:", buf.slice(0, 3).toString("hex"));
  }
})().catch(e => console.log("ERR:", e.message));
