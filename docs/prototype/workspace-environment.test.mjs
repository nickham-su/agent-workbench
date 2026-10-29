import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Window } from '../agent-workbench/node_modules/happy-dom/lib/index.js';

// 原型级 DOM 验证，仅使用项目已有 happy-dom；不运行命令、不请求网络。
const html = fs.readFileSync(new URL('./workspace-environment.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, '存在内嵌脚本');
new vm.Script(source);
assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b/);
assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)=["']https?:/);
assert.doesNotMatch(html, /hiddenIds|isHidden|\breveal\b|\bmasked\b|i-eye|敏感示例默认隐藏|重新隐藏|眼睛切换/);
assert.doesNotMatch(html, /草稿|未保存更改|所有更改已保存|放弃更改|保存更改|savedRows|draftRows|editorSnapshot|updateSaveStatus|\bdirty\b|save-bar|save-status|save-hint/);
let assertions = 0;
const windows = [];
function createPage(width = 1440) {
  const window = new Window({ url: 'https://prototype.example.test' });
  window.happyDOM.setWindowSize({ width, height: 900 });
  windows.push(window);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ''));
  window.eval(source);
  const document = window.document;
  return {
    window, document,
    get: (id) => document.getElementById(id),
    rows: () => [...document.querySelectorAll('#rows tr')],
    row: (id) => document.querySelector('#rows tr[data-id="' + id + '"]'),
    input(id, value) {
      const node = document.getElementById(id);
      node.value = value;
      node.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    filter(value) {
      document.getElementById('statusFilter').value = value;
      document.getElementById('statusFilter').dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    submit() { document.getElementById('variableForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    escape() { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }
  };
}
function check(condition, description) { assert.ok(condition, description); assertions++; }
try {
  const p = createPage();
  check(p.rows().length === 5, '初始五行');
  check(p.get('count').textContent === '5 个变量 · 4 个启用', '初始计数');
  check(!p.get('save') && !p.get('discard') && !p.get('saveStatus'), '无全局保存、放弃或状态控件');
  check(!p.document.querySelector('.tool > footer'), '移除全局保存栏且不留空白栏');
  check(p.row(4).querySelector('.value-text').textContent === 'prototype-placeholder-not-a-real-secret', '虚构敏感示例初始直接显示');
  check(p.row(1).querySelector('.value-text').textContent === 'development' && p.row(3).querySelector('.value-text').textContent === 'http://127.0.0.1:7890', '普通与停用变量都直接显示值');
  check(!p.document.querySelector('.value-cell button'), '值列没有显隐按钮');
  check(p.row(5).textContent.includes('空字符串'), '显式空值标识');
  check(p.document.querySelectorAll('[id]').length === new Set([...p.document.querySelectorAll('[id]')].map((n) => n.id)).size, 'HTML ID 唯一');

  check(!!p.document.querySelector('.workspace-header'), '保留全局 Workspace 顶栏');
  check(!p.document.querySelector('.tool-header, .tool-title, .scope-label'), '删除重复工具标题和空白工具栏');
  const heading = p.get('pageTitle').parentElement;
  check(heading.classList.contains('page-heading') && p.get('addVariable').parentElement === heading, '新增按钮与正文标题同属标题行');
  check(heading.lastElementChild === p.get('addVariable') && heading.closest('.main-scroll')?.nextElementSibling?.classList.contains('side'), '新增按钮位于正文右端且在侧栏之前');
  check(!p.document.querySelector('.notice, .table-caption'), '删除黄色提示条和表格显隐说明');
  const effectCopy = '保存后，下一次 bash 调用和新建终端生效。已有终端与运行中的命令不受影响。';
  const rules = p.document.querySelector('.side .rules');
  check(rules.previousElementSibling.textContent === '配置规则' && rules.children.length === 5 && !html.includes(effectCopy), '删除重复生效句，保留其他五条配置规则');
  const effects = [...p.document.querySelectorAll('.side .effect-item')];
  check(effects.length === 2, '保留上方两项生效范围说明');
  check(effects[0].querySelector('.effect-title').textContent === 'bash 工具' && effects[0].querySelector('.effect-desc').textContent === '下一次调用使用新配置。运行中的命令保持原环境。', '保留 bash 生效范围说明');
  check(effects[1].querySelector('.effect-title').textContent === '终端' && effects[1].querySelector('.effect-desc').textContent === '新建会话使用新配置。已有会话重连不会更新。', '保留终端生效范围说明');
  for (const width of [1080, 1440]) {
    // 各视口使用独立页面，避免 DOM 模拟器跨 resize 的样式缓存影响断言。
    const sized = createPage(width);
    const headingStyle = sized.window.getComputedStyle(sized.get('pageTitle').parentElement);
    const sideStyle = sized.window.getComputedStyle(sized.document.querySelector('.side'));
    check(headingStyle.display === 'flex' && headingStyle.justifyContent === 'space-between' && sized.window.getComputedStyle(sized.document.querySelector('.main-scroll')).minWidth === '0', width + 'px 下正文可收缩且标题与按钮分居两端（样式断言）');
    check(sideStyle.width === (width === 1080 ? '250px' : '270px') && sideStyle.flex === '0 0 auto' && sized.window.getComputedStyle(sized.get('addVariable')).flex === '0 0 auto', width + 'px 下侧栏与新增按钮保持自身尺寸（样式断言）');
  }
  check(p.window.getComputedStyle(p.row(4).querySelector('.value-text')).overflowWrap === 'anywhere', '长变量值换行而不挤压侧栏');
  p.filter('disabled');
  check(p.rows().length === 1 && p.row(3), '停用筛选');
  p.filter('enabled');
  check(p.rows().length === 4 && !p.row(3), '启用筛选');
  p.filter('all');
  p.input('search', '不存在');
  check(p.rows().length === 0 && !p.get('empty').hidden, '搜索空状态');
  p.get('emptyAction').click();
  check(p.rows().length === 5, '清除筛选');
  p.input('search', '开发接口');
  check(p.rows().length === 1 && p.row(2), '备注搜索');
  p.input('search', '');

  const savedToast = () => p.get('toast').textContent.includes('已保存（演示）');
  p.row(1).querySelector('[role="switch"]').focus();
  p.row(1).querySelector('[role="switch"]').click();
  check(p.row(1).querySelector('[role="switch"]').getAttribute('aria-checked') === 'false' && savedToast(), '停用立即模拟保存并提示，无需二次保存');
  check(p.document.activeElement === p.row(1).querySelector('[role="switch"]'), '行重绘恢复焦点');
  p.row(1).querySelector('.actions button').click();
  check(p.get('variableEnabled').getAttribute('aria-checked') === 'false', '编辑器立即读取已经保存的停用状态');
  p.get('cancelDrawer').click();
  p.row(1).querySelector('[role="switch"]').click();
  check(p.row(1).querySelector('[role="switch"]').getAttribute('aria-checked') === 'true' && savedToast(), '启用立即模拟保存并提示');
  p.filter('disabled');
  p.row(3).querySelector('[role="switch"]').click();
  check(p.rows().length === 0 && p.document.activeElement === p.get('statusFilter') && savedToast(), '筛选中的开关立即保存，行消失后焦点回到筛选');
  p.filter('all');
  p.row(3).querySelector('[role="switch"]').click();
  check(p.row(4).querySelector('.value-text').textContent === 'prototype-placeholder-not-a-real-secret', '直接保存不改变明文显示');

  p.get('addVariable').focus(); p.get('addVariable').click();
  check(!p.get('drawerOverlay').hidden && p.document.activeElement === p.get('variableName'), '抽屉打开聚焦名称');
  check(p.get('app').inert, '模态抽屉隔离主界面');
  check(p.get('applyVariable').textContent === '保存' && p.get('drawerIntro').textContent.includes('本原型内存中模拟保存'), '抽屉仅一个保存动作且说明内存演示');
  for (const name of ['', '9BAD', 'HAS SPACE', 'AWB_TEST', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_1', 'NODE_ENV']) {
    p.input('variableName', name); p.submit();
    check(!p.get('nameError').hidden && !p.get('drawerOverlay').hidden, '非法、保留或重复名称被拒绝：' + (name || '(空)'));
  }
  check(p.rows().length === 5, '校验失败不修改唯一的内存列表');
  p.input('variableName', 'LITERAL_TEST');
  p.input('variableValue', '  $PATH\n$(not-a-command)  ');
  p.input('variableRemark', '<img src=x onerror=alert(1)>');
  p.submit();
  check(p.get('drawerOverlay').hidden && p.rows().length === 6 && savedToast(), '新增点击保存即更新列表并关闭抽屉，无需二次保存');
  check(p.row(6).textContent.includes('<img src=x onerror=alert(1)>') && !p.row(6).querySelector('img'), '动态文本无 HTML 注入');
  check(p.row(6).querySelector('.value-text').textContent === '  $PATH\n$(not-a-command)  ', '新增后直接显示值并保留字面空格换行');
  check(p.window.getComputedStyle(p.row(6).querySelector('.value-text')).whiteSpace === 'pre-wrap', '列表样式保留值中的空格与换行');
  p.row(6).querySelector('.actions button').click();
  check(p.get('variableValue').value === '  $PATH\n$(not-a-command)  ', '字面值、空格换行完全保留');
  p.input('variableName', 'GIT_BUSINESS_LABEL');
  p.input('variableValue', ''); p.submit();
  check(p.row(6).textContent.includes('GIT_BUSINESS_LABEL') && p.row(6).textContent.includes('空字符串') && savedToast(), '编辑直接保存，允许普通业务 Git 名称及空值');
  p.row(6).querySelector('.actions button').click();
  check(p.get('variableName').value === 'GIT_BUSINESS_LABEL' && p.get('variableValue').value === '' && p.get('applyVariable').textContent === '保存', '重开立即读取已保存修改且主按钮仍为保存');
  p.input('variableValue', 'edited and saved'); p.submit();
  check(p.row(6).querySelector('.value-text').textContent === 'edited and saved' && savedToast(), '第二次编辑立即保存并明文显示');

  const listState = () => p.rows().map((row) => [row.dataset.id, row.textContent, row.querySelector('[role="switch"]').getAttribute('aria-checked')]);
  const closeActions = {
    '取消': () => p.get('cancelDrawer').click(),
    '关闭按钮': () => p.get('closeDrawer').click(),
    'Escape': () => p.escape(),
    '遮罩': () => p.get('drawerOverlay').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }))
  };
  for (const mode of ['新增', '编辑']) {
    for (const [label, close] of Object.entries(closeActions)) {
      const before = listState();
      const opener = mode === '新增' ? p.get('addVariable') : p.row(6).querySelector('.actions button');
      opener.focus(); opener.click();
      p.input('variableName', 'CANCELLED_INPUT');
      p.input('variableValue', 'only temporary input');
      p.input('variableRemark', '取消后不保留');
      p.get('variableEnabled').click();
      close();
      check(p.get('drawerOverlay').hidden && p.get('confirmOverlay').hidden, mode + '通过' + label + '直接取消输入，不弹额外确认');
      check(JSON.stringify(listState()) === JSON.stringify(before), mode + '通过' + label + '取消不改变已保存列表');
      check(!p.get('app').inert && p.document.activeElement === opener && p.get('variableValue').value === '', mode + '通过' + label + '关闭清理输入并恢复焦点');
      opener.click();
      check(p.get('variableName').value === (mode === '新增' ? '' : 'GIT_BUSINESS_LABEL') && p.get('variableValue').value === (mode === '新增' ? '' : 'edited and saved'), mode + '取消后重新打开不恢复临时输入');
      p.get('cancelDrawer').click();
    }
  }

  p.get('addVariable').click();
  const drawerControls = [...p.get('drawerOverlay').querySelectorAll('button, input, textarea')];
  const firstDrawerControl = drawerControls[0], lastDrawerControl = drawerControls.at(-1);
  lastDrawerControl.focus();
  p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check(p.document.activeElement === firstDrawerControl, '抽屉 Tab 在首尾循环');
  p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  check(p.document.activeElement === lastDrawerControl, '抽屉 Shift+Tab 在首尾循环');
  p.escape();

  p.row(6).querySelector('.actions button:last-child').click();
  check(p.get('confirmBody').textContent.includes('删除后') && p.get('confirmBody').textContent.includes('不会强制关闭已有终端') && !p.get('confirmBody').textContent.includes('保存后'), '删除确认说明确认后即删除，旧终端不受影响，不等待页面保存');
  check(p.get('app').inert && p.document.activeElement === p.get('confirmCancel'), '删除确认隔离背景并聚焦取消');
  p.get('confirmAccept').focus();
  p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check(p.document.activeElement === p.get('confirmCancel'), '删除确认 Tab 循环');
  p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  check(p.document.activeElement === p.get('confirmAccept'), '删除确认 Shift+Tab 循环');
  p.get('confirmCancel').click();
  check(p.rows().length === 6, '取消删除');
  p.row(6).querySelector('.actions button:last-child').focus();
  p.row(6).querySelector('.actions button:last-child').click(); p.escape();
  check(p.get('confirmOverlay').hidden && p.row(6) && !p.get('app').inert && p.document.activeElement === p.row(6).querySelector('.actions button:last-child'), 'Escape 取消删除不改变列表且恢复焦点');
  p.row(6).querySelector('.actions button:last-child').click();
  p.get('confirmOverlay').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
  check(p.get('confirmOverlay').hidden && p.row(6), '遮罩取消删除不改变列表');
  p.row(6).querySelector('.actions button:last-child').click(); p.get('confirmAccept').click();
  check(p.rows().length === 5 && !p.row(6) && savedToast(), '确认删除立即保存，无需二次保存');
  check(p.get('confirmOverlay').hidden && !p.get('app').inert && p.document.activeElement === p.get('addVariable'), '删除后关闭模态并恢复可用焦点');
  p.get('addVariable').click();
  p.input('variableName', 'AFTER_DELETE'); p.submit();
  check(p.rows().length === 6 && p.row(7) && !p.row(6) && savedToast(), '后续新增不恢复已删除行或任何快照');
  check(p.row(4).querySelector('.value-text').textContent === 'prototype-placeholder-not-a-real-secret' && !p.document.querySelector('.value-cell button'), '直接保存后仍保持明文且不恢复显隐按钮');

  p.get('addVariable').focus(); p.get('addVariable').click(); p.escape();
  check(p.get('drawerOverlay').hidden && p.document.activeElement === p.get('addVariable'), '无更改关闭并恢复焦点');
  p.document.querySelector('[data-demo]').click();
  check(p.get('toast').textContent === '仅原型展示，不执行真实操作。', '背景按钮有演示反馈');

  const fresh = createPage();
  check(fresh.rows().length === 5 && fresh.row(1).querySelector('[role="switch"]').getAttribute('aria-checked') === 'true' && !fresh.row(7), '重新加载恢复初始示例，不存在真实持久化');
  check(fresh.document.querySelector('.demo-note').textContent.includes('刷新后恢复初始数据') && fresh.document.querySelector('.security').textContent.includes('不实际执行 bash 或创建终端'), '页面说明仅内存与无真实运行环境变更');
  for (const row of [...fresh.rows()]) {
    fresh.row(row.dataset.id).querySelector('.actions button:last-child').click();
    fresh.get('confirmAccept').click();
    check(!fresh.row(row.dataset.id) && fresh.get('toast').textContent.includes('已保存（演示）'), '每次删除都立即保存：' + row.dataset.id);
  }
  check(fresh.rows().length === 0 && fresh.get('emptyTitle').textContent.includes('还没有'), '删除全部展示真正空状态');
  fresh.get('emptyAction').click();
  check(!fresh.get('drawerOverlay').hidden, '空状态可添加变量');

  console.log('通过：JS 语法、HTML ID/离线结构检查及 ' + assertions + ' 项 DOM 交互断言。');
} finally {
  for (const window of windows) await window.happyDOM.close();
}
