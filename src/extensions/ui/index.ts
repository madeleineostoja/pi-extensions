import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL } from "./activity.js";
import { ActivityStore } from "./activity-store.js";
import { installActivityWidget } from "./activity-widget.js";
import { installFooter } from "./footer.js";

export default function (pi: ExtensionAPI): void {
  installFooter(pi);
  let disposeActivity: (() => void) | undefined;
  const clearActivity = () => {
    disposeActivity?.();
    disposeActivity = undefined;
  };
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    clearActivity();
    const store = new ActivityStore();
    const unsubscribe = pi.events.on(ACTIVITY_CHANNEL, (event) => {
      try {
        store.accept(event);
      } catch {
        // Activity is a best-effort UI projection.
      }
    });
    const disposeWidget = installActivityWidget(ctx, store);
    disposeActivity = () => {
      unsubscribe();
      disposeWidget();
      store.dispose();
    };
  });
  pi.on("session_shutdown", clearActivity);
}
