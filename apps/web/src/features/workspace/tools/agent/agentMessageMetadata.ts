function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}

/** 当消息不是今天创建时补充月-日，所有字段均按浏览器本地时区展示。 */
export function formatAgentMessageTimestamp(timestamp: number, now = Date.now()) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "";
  const createdAt = new Date(timestamp);
  const today = new Date(now);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(today.getTime())) return "";

  const time = `${padTimePart(createdAt.getHours())}:${padTimePart(createdAt.getMinutes())}:${padTimePart(createdAt.getSeconds())}`;
  const isToday = createdAt.getFullYear() === today.getFullYear()
    && createdAt.getMonth() === today.getMonth()
    && createdAt.getDate() === today.getDate();
  if (isToday) return time;

  return `${padTimePart(createdAt.getMonth() + 1)}-${padTimePart(createdAt.getDate())} ${time}`;
}
