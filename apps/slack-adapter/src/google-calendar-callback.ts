import type {
  CalendarSyncResult,
  GoogleCalendarIdentity,
  GoogleCalendarService,
} from "./google-calendar-service.ts";

type CalendarCallbackService = Pick<GoogleCalendarService, "complete" | "syncUser">;

export interface GoogleCalendarCallbackResult {
  identity: GoogleCalendarIdentity;
  sync: CalendarSyncResult | null;
  syncWarning: string | null;
}

export async function completeGoogleCalendarCallback(
  service: CalendarCallbackService,
  code: string,
  state: string,
): Promise<GoogleCalendarCallbackResult> {
  const identity = await service.complete(code, state);
  try {
    const sync = await service.syncUser(identity.slackTeamId, identity.slackUserId);
    return { identity, sync, syncWarning: null };
  } catch (error) {
    return {
      identity,
      sync: null,
      syncWarning: error instanceof Error ? error.message : "Calendar初回同期に失敗しました。",
    };
  }
}
