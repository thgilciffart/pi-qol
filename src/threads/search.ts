import type { SessionInfo } from '@earendil-works/pi-coding-agent';

/** Search the same fields in the command and the interactive picker. */
export function sessionSearchText(session: SessionInfo): string {
  return `${session.name ?? ''}\n${session.firstMessage}\n${session.cwd}\n${session.id}`.toLocaleLowerCase();
}
