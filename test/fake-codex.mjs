import {writeFileSync} from 'node:fs';
const args = process.argv.slice(2); const workspace = args[args.indexOf('-C') + 1];
let prompt = ''; for await (const bytes of process.stdin) prompt += bytes.toString();
writeFileSync(`${workspace}/fixture.json`, JSON.stringify({pid: process.pid, workspace, prompt, hasMossKey: !!process.env.MOSS_API_KEY}));
if (prompt.includes('FIXTURE_HANG')) setInterval(() => {}, 1000);
else if (prompt.includes('FIXTURE_FAIL')) process.exit(2);
else if (prompt.includes('FIXTURE_EMPTY')) process.exit(0);
else {
  console.log(JSON.stringify({type: 'item.started', item: {type: 'web_search'}}));
  if (prompt.includes('FIXTURE_WAIT')) await new Promise(resolve => setTimeout(resolve, 180));
  console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: '后台连接成功：FIXTURE_RESULT'}}));
}
