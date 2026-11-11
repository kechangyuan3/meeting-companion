const $=id=>document.getElementById(id);
let timer=null,index=0,elapsed=0,paused=false;
const transcript=[];
const sample=[['你','小莫，我们在讨论周末活动。你先听着，查一下上海和杭州的天气。'],['小莫','好的，你们继续讨论。我让后台助手核实一下。'],['你','活动优先考虑周六；室内场地也准备一个备选。'],['小莫','示例查询已完成：比较天气和出行条件后，下一步可以确认地点及室内备选。'],['你','那先让小林联系场地，明天下午给我们两个方案。'],['小莫','记下了：小林明天下午提供两个场地方案；周六为优先日期，室内场地保留为备选。']];
function add(role,text){$('empty')?.remove();const row=document.createElement('div');row.className=`message ${role==='你'?'user':'assistant'}`;const meta=document.createElement('div');meta.className='message-meta';meta.textContent=`${role} · 示例`;const p=document.createElement('p');p.textContent=text;row.append(meta,p);$('transcript').append(row);transcript.push({role,text});$('transcript-count').textContent=`${transcript.length} 条 · 示例`;$('transcript').scrollTop=$('transcript').scrollHeight;}
function task(){ $('tasks-empty')?.remove();let card=$('demo-task');if(!card){card=document.createElement('div');card.id='demo-task';card.className='task';$('tasks').append(card);}card.textContent=index>=4?'示例任务已完成 → 结果送达小莫':'示例任务：比较两个城市的天气和出行安排 → 正在查询…'; }
function paint(active){$('start').disabled=active;$('mute').disabled=!active;$('stop').disabled=!active;$('orb').className=active?'orb listening':'orb';$('live-dot').className=active?'live-dot active':'live-dot';$('connection-label').textContent=active?'示例会话进行中':'演示已结束';$('meeting-title').textContent=active?'讨论继续，助手接着做。':'给 AI 留一张椅子';$('meeting-subtitle').textContent='本页播放预设文字交互，不会录音或调用服务。';}
function finish(){clearInterval(timer);timer=null;paint(false);$('mute').textContent='暂停演示';paused=false;}
function tick(){if(paused)return;elapsed++;$('duration').textContent=`00:${String(elapsed).padStart(2,'0')}`;if(elapsed%2===1&&index<sample.length){const [role,text]=sample[index++];add(role,text);if(index>=2)task();}if(index===sample.length)finish();}
$('start').onclick=()=>{if(timer)return;if(index===sample.length){index=0;elapsed=0;transcript.length=0;$('transcript').replaceChildren();$('tasks').replaceChildren();}paint(true);tick();timer=setInterval(tick,1000);};
$('mute').onclick=()=>{paused=!paused;$('mute').textContent=paused?'继续演示':'暂停演示';$('connection-label').textContent=paused?'示例已暂停':'示例会话进行中';};
$('stop').onclick=finish;
$('shutdown').onclick=()=>{finish();index=0;elapsed=0;transcript.length=0;$('transcript').replaceChildren();$('tasks').replaceChildren();$('transcript-count').textContent='0 条';$('duration').textContent='00:00';$('connection-label').textContent='演示待开始';};
$('test-backend').onclick=()=>{task();$('backend-message').textContent='这是预设的任务状态示例，不会运行 Codex。';};
$('export').onclick=()=>{const text='# 会议搭子 · 示例对话\n\n以下内容为预设演示。\n\n'+transcript.map(row=>`**${row.role}**\n\n${row.text}`).join('\n\n');const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='会议搭子-示例对话.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
