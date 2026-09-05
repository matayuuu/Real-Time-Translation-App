export const IPC_CHANNELS = {
  applicationGetInfo: "application:get-info",
  configurationGet: "configuration:get",
  configurationChoose: "configuration:choose",
  translationCreateSecret: "translation:create-secret",
  recordingStart: "recording:start",
  recordingAppend: "recording:append",
  recordingStop: "recording:stop",
  recordingExport: "recording:export",
  recordingDiscard: "recording:discard",
  appEvent: "app:event",
} as const;
