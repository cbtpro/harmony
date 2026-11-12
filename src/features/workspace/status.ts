import { inject, onActivated, onDeactivated, onUnmounted, watchEffect } from 'vue';
import type { InjectionKey, Ref, WatchStopHandle } from 'vue';

export const workspaceStatus = Symbol('workspace status') as InjectionKey<Ref<string>>;

export function useWorkspaceStatus(message: () => string) {
  const status = inject(workspaceStatus);
  if (!status) return;
  let stop: WatchStopHandle | undefined;

  onActivated(() => {
    stop = watchEffect(() => { status.value = message(); });
  });

  const deactivate = () => {
    if (!stop) return;
    stop();
    stop = undefined;
    status.value = '';
  };

  onDeactivated(deactivate);
  onUnmounted(deactivate);
}
