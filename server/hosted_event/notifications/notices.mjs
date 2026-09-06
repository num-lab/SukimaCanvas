/**
 * Content for Hosted Event Service lifecycle notices.
 *
 * Every lifecycle notice is composed once, in both supported hosted languages
 * (`zh-CN` first, then `en`), because mail has no request context to negotiate
 * a language and recipients of one event read either language. The service
 * timezone (mainland China, UTC+8 by default) renders event times, and no
 * notice carries links: the consoles they refer to are reached by logging in,
 * and sensitive links (verification, password reset) stay on the account
 * flows that build them from the initiating request with server-issued
 * single-use tokens.
 *
 * @typedef {{
 *   subject: string,
 *   body: string,
 * }} ComposedNotice
 */

const KINDS = {
  ACCOUNT_VERIFICATION: "account_verification",
  ACCOUNT_PASSWORD_RESET: "account_password_reset",
  RESERVATION_APPROVED: "reservation_approved",
  RESERVATION_REJECTED: "reservation_rejected",
  CHANGE_REQUEST_APPLIED: "change_request_applied",
  CHANGE_REQUEST_REJECTED: "change_request_rejected",
  EVENT_CANCELLED: "event_cancelled",
  SESSION_UPCOMING: "session_upcoming",
  SESSION_ARCHIVED: "session_archived",
  SESSION_ARCHIVE_FAILED: "session_archive_failed",
  WEBHOOK_SUSPENDED: "webhook_suspended",
};

const INTERNAL_ARCHIVE_FAILURE_REASON = {
  "zh-CN": "内部错误",
  en: "an internal error occurred",
};

/**
 * Human-readable archive failure reasons for notices, keyed by the
 * deterministic failure codes the close pipeline records.
 *
 * @type {{[code: string]: {"zh-CN": string, en: string}}}
 */
const ARCHIVE_FAILURE_REASONS = {
  snapshot_save_failed: {
    "zh-CN": "快照保存失败",
    en: "the board snapshot could not be saved",
  },
  ledger_unavailable: {
    "zh-CN": "变更记录不可用",
    en: "the mutation ledger was unavailable",
  },
  final_sequence_mismatch: {
    "zh-CN": "最终序号校验不一致",
    en: "the final sequence disagreed between snapshot and ledger",
  },
  archive_conflict: {
    "zh-CN": "归档对象冲突",
    en: "the archive object was already present",
  },
  storage_write_failed: {
    "zh-CN": "存储写入失败",
    en: "the archive storage could not be written",
  },
  seal_failed: {
    "zh-CN": "关闭状态推进失败",
    en: "the closing state could not be sealed",
  },
  internal: {
    "zh-CN": "内部错误",
    en: "an internal error occurred",
  },
};

/**
 * Formats one event time in the fixed service timezone as an unambiguous,
 * locale-neutral timestamp with its UTC offset.
 *
 * @param {number} ms
 * @param {number} offsetMinutes
 * @returns {string}
 */
function formatServiceTime(ms, offsetMinutes) {
  const safeOffset = Number.isFinite(offsetMinutes)
    ? Math.trunc(offsetMinutes)
    : 0;
  const shifted = new Date(ms + safeOffset * 60 * 1000);
  const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
  const sign = safeOffset < 0 ? "-" : "+";
  const absOffset = Math.abs(safeOffset);
  const offsetLabel = `UTC${sign}${Math.floor(absOffset / 60)}${
    absOffset % 60 === 0 ? "" : `:${pad(absOffset % 60)}`
  }`;
  return `${shifted.getUTCFullYear()}-${pad(
    shifted.getUTCMonth() + 1,
  )}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(
    shifted.getUTCMinutes(),
  )} (${offsetLabel})`;
}

/**
 * Assembles the final bilingual notice: the zh-CN version first, a clear
 * divider, then the en version.
 *
 * @param {{subject: string, body: string}} zh
 * @param {{subject: string, body: string}} en
 * @returns {ComposedNotice}
 */
function assemble(zh, en) {
  return {
    subject: `${zh.subject} · ${en.subject}`,
    body: `${zh.body}\n\n———\n\n${en.body}`,
  };
}

/**
 * @param {string} eventName
 * @returns {string}
 */
function quotedEventName(eventName) {
  return `「${eventName}」`;
}

/**
 * @param {{eventName: string, startsAtMs: number, seats: number, offsetMinutes: number}} input
 * @returns {ComposedNotice}
 */
function composeReservationApproved(input) {
  const name = input.eventName;
  const startsAt = formatServiceTime(input.startsAtMs, input.offsetMinutes);
  return assemble(
    {
      subject: `${quotedEventName(name)}的场地预订已通过`,
      body: `你好，

你为活动${quotedEventName(name)}提交的场地预订已通过审批。

活动时间：${startsAt}
参与名额：${input.seats}

你可以在 SukimaCanvas 主办方控制台查看详情。

—— SukimaCanvas`,
    },
    {
      subject: `Reservation approved for "${name}"`,
      body: `Hello,

the reservation for your event "${name}" has been approved.

Starts at: ${startsAt}
Seats: ${input.seats}

You can review the details in your organizer console on SukimaCanvas.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string}} input
 * @returns {ComposedNotice}
 */
function composeReservationRejected(input) {
  const name = input.eventName;
  return assemble(
    {
      subject: `${quotedEventName(name)}的场地预订未通过`,
      body: `你好，

很遗憾，你为活动${quotedEventName(name)}提交的场地预订未通过审批。

你可以在主办方控制台查看详情；如有需要，欢迎调整安排后重新提交。

—— SukimaCanvas`,
    },
    {
      subject: `Reservation not approved for "${name}"`,
      body: `Hello,

unfortunately, the reservation for your event "${name}" was not approved.

You can review the details in your organizer console and submit a new reservation if you like.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string, startsAtMs: number, seats: number, offsetMinutes: number}} input
 * @returns {ComposedNotice}
 */
function composeChangeRequestApplied(input) {
  const name = input.eventName;
  const startsAt = formatServiceTime(input.startsAtMs, input.offsetMinutes);
  return assemble(
    {
      subject: `${quotedEventName(name)}的变更申请已生效`,
      body: `你好，

你为活动${quotedEventName(name)}提交的变更申请已通过审批并生效。

新的活动时间：${startsAt}
新的参与名额：${input.seats}

你可以在 SukimaCanvas 主办方控制台查看详情。

—— SukimaCanvas`,
    },
    {
      subject: `Change applied to "${name}"`,
      body: `Hello,

the change request for your event "${name}" has been approved and applied.

New schedule: ${startsAt}
New seats: ${input.seats}

You can review the details in your organizer console on SukimaCanvas.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string}} input
 * @returns {ComposedNotice}
 */
function composeChangeRequestRejected(input) {
  const name = input.eventName;
  return assemble(
    {
      subject: `${quotedEventName(name)}的变更申请未通过`,
      body: `你好，

你为活动${quotedEventName(name)}提交的变更申请未通过审批。活动原有安排保持不变。

你可以在主办方控制台查看详情。

—— SukimaCanvas`,
    },
    {
      subject: `Change request not approved for "${name}"`,
      body: `Hello,

the change request for your event "${name}" was not approved. The event keeps its current schedule.

You can review the details in your organizer console.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string, startsAtMs: number, audience: "organizer" | "participant", offsetMinutes: number}} input
 * @returns {ComposedNotice}
 */
function composeEventCancelled(input) {
  const name = input.eventName;
  const startsAt = formatServiceTime(input.startsAtMs, input.offsetMinutes);
  if (input.audience === "participant") {
    return assemble(
      {
        subject: `你加入的活动${quotedEventName(name)}已取消`,
        body: `你好，

很遗憾，你已加入的活动${quotedEventName(name)}（原定 ${startsAt}）已被组织者取消。活动页面不再接受入场。

—— SukimaCanvas`,
      },
      {
        subject: `Event cancelled: "${name}"`,
        body: `Hello,

the event "${name}" you joined (previously scheduled for ${startsAt}) has been cancelled by its organizer. Its event page no longer admits participants.

—— SukimaCanvas`,
      },
    );
  }
  return assemble(
    {
      subject: `${quotedEventName(name)}已取消`,
      body: `你好，

你组织的活动${quotedEventName(name)}（原定 ${startsAt}）已取消。活动页面不再接受入场，预订的容量也已释放。

—— SukimaCanvas`,
    },
    {
      subject: `Event cancelled: "${name}"`,
      body: `Hello,

your event "${name}" (previously scheduled for ${startsAt}) has been cancelled. Its event page no longer admits participants, and the reserved capacity has been released.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string, startsAtMs: number, offsetMinutes: number}} input
 * @returns {ComposedNotice}
 */
function composeSessionUpcoming(input) {
  const name = input.eventName;
  const startsAt = formatServiceTime(input.startsAtMs, input.offsetMinutes);
  return assemble(
    {
      subject: `${quotedEventName(name)}即将开始`,
      body: `你好，

你组织的活动${quotedEventName(name)}将于 ${startsAt} 开始。活动开始后参与者即可入场，请提前确认活动安排。

—— SukimaCanvas`,
    },
    {
      subject: `"${name}" is starting soon`,
      body: `Hello,

your event "${name}" starts at ${startsAt}. Participants can join the board once it opens.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string, audience: "organizer" | "participant"}} input
 * @returns {ComposedNotice}
 */
function composeSessionArchived(input) {
  const name = input.eventName;
  if (input.audience === "participant") {
    return assemble(
      {
        subject: `你参与的活动${quotedEventName(name)}已结束`,
        body: `你好，

活动${quotedEventName(name)}的画板已关闭。感谢你的参与！

—— SukimaCanvas`,
      },
      {
        subject: `The event you joined has closed: "${name}"`,
        body: `Hello,

the board for "${name}" is now closed. Thank you for taking part!

—— SukimaCanvas`,
      },
    );
  }
  return assemble(
    {
      subject: `${quotedEventName(name)}已结束并完成归档`,
      body: `你好，

活动${quotedEventName(name)}的画板已关闭，全部内容已完整归档保存。你可以在主办方控制台查看归档结果。

—— SukimaCanvas`,
    },
    {
      subject: `"${name}" has closed and been archived`,
      body: `Hello,

the board for "${name}" is now closed and its full contents have been archived. You can review the archive result in your organizer console.

—— SukimaCanvas`,
    },
  );
}

/**
 * @param {{eventName: string, failureCode: string}} input
 * @returns {ComposedNotice}
 */
function composeSessionArchiveFailed(input) {
  const name = input.eventName;
  const reason =
    ARCHIVE_FAILURE_REASONS[input.failureCode] ||
    INTERNAL_ARCHIVE_FAILURE_REASON;
  return assemble(
    {
      subject: `${quotedEventName(name)}的归档正在等待恢复`,
      body: `你好，

活动${quotedEventName(name)}关闭时的归档未能完成（原因：${reason["zh-CN"]}）。画板内容仍然安全保存；系统会自动重试，平台运营者也可以在控制台手动重试。

—— SukimaCanvas`,
    },
    {
      subject: `Archive of "${name}" is awaiting recovery`,
      body: `Hello,

the archive step when "${name}" closed did not complete (reason: ${reason.en}). The board contents remain safely stored; the system retries automatically, and a platform operator can also retry from the console.

—— SukimaCanvas`,
    },
  );
}

/**
 * Webhook suspension: the Organizer Owner learns that their endpoint kept
 * failing for 24 hours, that queued event records are safe, and that
 * resuming after a fix delivers them. The endpoint is identified by its host
 * only — never the full URL with any private path — and no signing material
 * is included.
 *
 * @param {{
 *   endpointHost: string,
 *   suspendedAtMs: number,
 *   offsetMinutes: number,
 * }} input
 * @returns {ComposedNotice}
 */
function composeWebhookSuspended(input) {
  const host = input.endpointHost || "your webhook endpoint";
  const suspendedAt = formatServiceTime(
    input.suspendedAtMs,
    input.offsetMinutes,
  );
  return assemble(
    {
      subject: `Webhook 订阅已暂停（${host}）`,
      body: `你好，

你们指向 ${host} 的 Webhook 订阅因连续 24 小时投递失败已被暂停。暂停期间产生的事件记录都已安全保存；修复接收端后，在 Organizer 控制台恢复订阅，这些记录会立即投递。

暂停时间：${suspendedAt}

—— SukimaCanvas`,
    },
    {
      subject: `Webhook subscription suspended (${host})`,
      body: `Hello,

your webhook subscription pointing at ${host} was suspended after 24 hours of failed deliveries. Every event record queued during the suspension is safely stored; once the endpoint is fixed, resuming the subscription from the Organizer console delivers them.

Suspended at: ${suspendedAt}

—— SukimaCanvas`,
    },
  );
}

export {
  KINDS as NOTICE_KINDS,
  composeChangeRequestApplied,
  composeChangeRequestRejected,
  composeEventCancelled,
  composeReservationApproved,
  composeReservationRejected,
  composeSessionArchiveFailed,
  composeSessionArchived,
  composeSessionUpcoming,
  composeWebhookSuspended,
};
