import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import ephemeral from './src/ephemeral.ts';
import betterExport from './src/export/index.ts';
import metrics from './src/metrics.ts';
import goal from './src/goal.ts';
import threads from './src/threads.ts';
import autoName from './src/auto-name.ts';
import continueTurn from './src/continue.ts';
import thinking from './src/thinking.ts';
import askQuestions from './src/ask-questions/index.ts';
import statusLine from './src/status-line/index.ts';

export default function qol(pi: ExtensionAPI): void {
  ephemeral(pi);
  betterExport(pi);
  metrics(pi);
  goal(pi);
  threads(pi);
  autoName(pi);
  continueTurn(pi);
  thinking(pi);
  askQuestions(pi);
  statusLine(pi);
}
