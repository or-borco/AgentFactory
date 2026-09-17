export * from "./task-provider";
// Exported directly (not only reachable via createTaskProvider) so a caller that has raw
// credentials but no persisted Connection row yet — the connect-time verify step — can construct
// one without faking a Connection object. See apps/web/src/app/api/connections/jira/route.ts.
export { JiraTaskProvider } from "./jira/jira-task-provider";
export * from "./channel-provider";
export { TelegramChannelAdapter } from "./telegram/telegram-channel-adapter";
