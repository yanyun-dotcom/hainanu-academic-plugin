import type {AcademicPlugin, AuthState, ErrorCode, HostSdk, HttpResponse, Result} from '../../../sdk/index';

const origin = 'https://jxgl.hainanu.edu.cn';
const base = origin + '/jsxsd';
const entry = base + '/';
const frame = base + '/framework/xsMainV_new.htmlx';
const captchaImage = base + '/verifycode.servlet';
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const accountNames = /^(userAccount|USERNAME|username|user|userid|account|loginname|TextBox1)$/i;
const passwordNames = /^(userPassword|PASSWORD|password|passwd|pwd|TextBox2)$/i;
const captchaNames = /^(RANDOMCODE|yzm|authcode|captcha|verifycode|checkcode|vcode|code)$/i;

const ok = <T>(data: T): Result<T> => ({ok: true, data});
function fail(code: ErrorCode, message: string): never { throw Object.assign(new Error(message), {code}); }

/**
 * The school login page encodes both fields with conwork.js encodeInp():
 * base64 over UTF-16 code units, '=' padding at index 64. Copying that exact
 * behaviour matters, because the host base64 helper encodes UTF-8 instead.
 */
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
function encodeInp(input: string): string {
  let output = '', index = 0;
  do {
    const c1 = input.charCodeAt(index++), c2 = input.charCodeAt(index++), c3 = input.charCodeAt(index++);
    let e3 = ((c2 & 15) << 2) | (c3 >> 6), e4 = c3 & 63;
    if (isNaN(c2)) { e3 = 64; e4 = 64; } else if (isNaN(c3)) e4 = 64;
    output += alphabet.charAt(c1 >> 2) + alphabet.charAt(((c1 & 3) << 4) | (c2 >> 4)) + alphabet.charAt(e3) + alphabet.charAt(e4);
  } while (index < input.length);
  return output;
}

interface Pending {
  id: string; kind: 'captcha' | 'web'; expires: number;
  url?: string; fields?: Record<string, string>; captchaField?: string;
}
const token = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

async function pending(s: HostSdk, key: string) {
  const p = await s.state.get<Pending>('pending');
  if (!p || p.id !== key || p.expires < Date.now()) { await s.state.remove('pending'); fail('SESSION_EXPIRED', '登录验证已过期，请重新登录海南大学'); }
  return p;
}

function inputType(node: {attributes: Record<string, string>}): string {
  return (node.attributes.type || 'text').toLowerCase();
}

/** True when the page is still a login page rather than a logged-in frame. */
function loginPage(body: string, s: HostSdk): boolean {
  return s.html.select(body, 'input[type=password]').length > 0 || /id=["']?loginForm|Logon\.do\?method=logon/i.test(body);
}

/**
 * Reads the login controls the school page actually ships. Field names and the
 * surrounding form are read from the page instead of assumed, and a page without
 * a form tag still works because the submit address is taken from the page script.
 */
function loginTarget(html: string, s: HostSdk) {
  const inputs = s.html.select(html, 'input[name]');
  const password = inputs.find(node => inputType(node) === 'password')
    || inputs.find(node => passwordNames.test(node.attributes.name))
    || inputs.find(node => /pass/i.test(node.attributes.name));
  if (!password) return undefined;
  const account = inputs.find(node => accountNames.test(node.attributes.name))
    || inputs.find(node => inputType(node) === 'text' && !captchaNames.test(node.attributes.name) && !passwordNames.test(node.attributes.name) && !('hidden' in node.attributes));
  if (!account) return undefined;
  const forms = s.html.select(html, 'form,el-form');
  const form = forms.find(node => node.attributes.id === 'loginForm')
    || forms.find(node => node.html.includes(password.attributes.name))
    || forms[0];
  const fields: Record<string, string> = form ? s.html.form(form.html, 'form,el-form') : {};
  fields[account.attributes.name] = account.attributes.value || '';
  fields[password.attributes.name] = password.attributes.value || '';
  // A relative address is resolved against the school application, not the page.
  const declared = form?.attributes.action || '';
  const scripted = /["']([^"'<>]*\/xk\/LoginToXkLdap)["']/.exec(html)?.[1] || /["']([^"'<>]*\/xk\/LoginToXk)["']/.exec(html)?.[1] || '';
  const raw = (declared || scripted).trim();
  if (!raw) return undefined;
  const url = /^https?:\/\//i.test(raw) ? raw : raw.startsWith('/') ? origin + raw : base + '/' + raw.replace(/^\.?\//, '');
  if (!url.startsWith(base)) return undefined;
  return {
    fields, url, accountField: account.attributes.name, passwordField: password.attributes.name,
    captchaField: inputs.find(node => captchaNames.test(node.attributes.name))?.attributes.name,
  };
}

/** One same-origin redirect the page announces itself, used when it is not the login form. */
function announcedRedirect(html: string): string | undefined {
  const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"';\s]+)/i.exec(html)?.[1];
  const script = /(?:top|window|parent|self)\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i.exec(html)?.[1];
  const raw = (meta || script || '').trim();
  if (!raw) return undefined;
  const url = /^https?:\/\//i.test(raw) ? raw : raw.startsWith('/') ? origin + raw : base + '/' + raw.replace(/^\.?\//, '');
  return url.startsWith(origin + '/') ? url : undefined;
}

function errorText(html: string, s: HostSdk): string {
  const shown = s.html.select(html, '#showMsg,#msg,#errormsg,.alert-danger,.alert-error,[role=alert]').map(n => n.text).join(' ');
  const alerts = [...html.matchAll(/alert\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]).join(' ');
  return (shown + ' ' + alerts).replace(/\s+/g, ' ').trim();
}

/** Bounded, page-derived facts; never includes credentials, cookies or URLs. */
function describePage(page: HttpResponse, s: HostSdk): string {
  const title = (/<title[^>]*>([\s\S]{0,60}?)<\/title>/i.exec(page.body)?.[1] || '').replace(/\s+/g, ' ').trim();
  return 'HTTP ' + page.status + '，长度 ' + page.body.length + '，表单 ' + s.html.select(page.body, 'form,el-form').length
    + '，密码框 ' + s.html.select(page.body, 'input[type=password]').length + (title ? '，标题「' + title + '」' : '');
}

function identity(html: string, s: HostSdk) {
  const nameSelector = 'input[name=xm],.media-heading,[name=studentName],#xhxm,.user-name,#studentName';
  const idSelector = 'input[name=xh],input[name=studentId],#sessionUserKey,#studentId';
  const value = (selector: string) => {
    const node = s.html.select(html, selector)[0];
    return (node?.attributes.value || node?.text || '').replace(/\s+/g, ' ').trim();
  };
  let studentId = value(idSelector), studentName = value(nameSelector);
  // Only strip a title that is a separate word, as the shared protocol does; "合成学生" is a name.
  if (!s.html.select(html, nameSelector)[0]?.attributes.value) studentName = studentName.replace(/\s+(?:同学|学生|教师|老师)\s*$/, '').trim();
  const labels = s.html.select(html, '.middletopdwxxtit'), contents = s.html.select(html, '.middletopdwxxtit + .middletopdwxxcont');
  if (labels.length === contents.length) labels.forEach((label, index) => {
    const key = label.text.replace(/[\s:：]/g, '');
    if (key === '学号' && !studentId) studentId = contents[index].text.trim();
    if (key === '学生姓名' && !studentName) studentName = contents[index].text.trim();
  });
  return {studentId, studentName};
}

async function validate(s: HostSdk): Promise<Result<AuthState>> {
  const page = await s.http({url: frame + '?t1=1', purpose: 'query', charset: 'UTF-8'});
  if (page.status !== 200 || !page.url.startsWith(base + '/')) fail('SESSION_EXPIRED', '海南大学教务会话已失效，请重新登录');
  if (loginPage(page.body, s)) fail('SESSION_EXPIRED', '海南大学教务会话已失效，请重新登录');
  const info = identity(page.body, s);
  // The frame confirms a live session even when this release cannot map the student card.
  if (!info.studentId && !info.studentName && !/学生个人中心|退出登录|选课结果|学期理论课表|培养方案|我的课程/.test(page.body))
    fail('PAGE_CHANGED', '教务未返回可核实的学生身份（' + describePage(page, s) + '），请改用学校网页登录');
  const account = await s.state.get<string>('account');
  if (account && info.studentId && account !== info.studentId) fail('INVALID_CREDENTIALS', '登录账号与教务返回的学号不一致');
  const studentId = info.studentId || account || '';
  if (!studentId) fail('PAGE_CHANGED', '学校未返回可识别的学号，请改用学校网页登录');
  await s.state.remove('pending');
  return ok({status: 'authenticated', studentId, studentName: info.studentName || studentId});
}

/** Used while starting: an existing session is a bonus, never a reason to fail the login. */
async function existingSession(s: HostSdk): Promise<Result<AuthState> | undefined> {
  try { return await validate(s); } catch { return undefined; }
}

async function web(s: HostSdk): Promise<Result<AuthState>> {
  const p: Pending = {id: token(), kind: 'web', expires: Date.now() + 20 * 60_000};
  await s.state.set('pending', p);
  return ok({status: 'webLogin', continuationId: p.id, url: entry, completionUrl: frame});
}

async function captcha(s: HostSdk, p: Pending, refresh = false): Promise<Result<AuthState>> {
  if (p.kind !== 'captcha') fail('WEB_LOGIN_REQUIRED', '请在学校官方登录页完成验证');
  p.expires = Date.now() + 5 * 60_000;
  await s.state.set('pending', p);
  const request = (target: string) => s.http({url: target, purpose: 'auth', responseType: 'base64', sameOriginReferer: true, upgradeHttpRedirects: true, charset: 'UTF-8'});
  let image = await request(captchaImage + (refresh ? '?_=' + Date.now() : ''));
  let mimeType = (image.headers['Content-Type'] ?? image.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  // A page instead of an image means the servlet answered with something else; the
  // endpoint is a plain read, so one cache-busted retry is safe and often enough.
  if (image.status === 200 && !imageTypes.includes(mimeType) && loginPage(image.body, s)) {
    image = await request(captchaImage + '?_=' + Date.now());
    mimeType = (image.headers['Content-Type'] ?? image.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  }
  if (image.status !== 200) fail('PAGE_CHANGED', '学校验证码接口返回 HTTP ' + image.status + '，请稍后重试或改用学校网页登录');
  if (!imageTypes.includes(mimeType) || !image.body) fail('PAGE_CHANGED', '学校验证码接口返回了 ' + (mimeType || '空内容') + ' 而不是图片（' + describePage(image, s) + '），请改用学校网页登录');
  return ok({status: 'captcha', continuationId: p.id, imageBase64: image.body, mimeType});
}

async function submit(s: HostSdk, p: Pending): Promise<Result<AuthState>> {
  if (!p.url || !p.fields) fail('SESSION_EXPIRED', '登录表单已失效，请重新登录');
  const response = await s.http({url: p.url, method: 'POST', purpose: 'auth', form: p.fields, sameOriginReferer: true, upgradeHttpRedirects: true, charset: 'UTF-8'});
  if (response.status >= 500 || response.status === 429) fail('NETWORK_RETRYABLE', '学校登录服务暂时不可用，请稍后重试');
  if (response.status !== 200) fail('PAGE_CHANGED', '学校登录服务返回 HTTP ' + response.status + '（' + describePage(response, s) + '），请稍后重试或改用学校网页登录');
  if (!response.url.startsWith(origin + '/')) fail('UNTRUSTED_URL', '学校登录跳转到了其他站点');
  if (!loginPage(response.body, s)) return validate(s);
  const message = errorText(response.body, s);
  if (/验证码|校验码|附加码/.test(message) && /错误|不正确|有误|失效|过期|无效/.test(message)) return captcha(s, p);
  if (/用户名或密码|账号或密码|帐号或密码|密码(?:错误|不正确|有误|无效)|用户不存在|账号不存在|帐号不存在|用户名不存在/.test(message)) {
    await s.state.remove('pending');
    fail('INVALID_CREDENTIALS', message.slice(0, 120) || '学校未接受账号或密码');
  }
  // Unrecognised answer: keep the session usable through the school's own login page.
  return web(s);
}

export default {
  auth: {
    start: async (a, _c, s) => {
      await s.state.remove('pending');
      await s.state.set('account', a.username.trim());
      let page = await s.http({url: entry, purpose: 'auth', upgradeHttpRedirects: true, charset: 'UTF-8'});
      if (!page.url.startsWith(origin + '/')) fail('UNTRUSTED_URL', '学校登录页跳转到了其他站点');
      if (page.status >= 500 || page.status === 429) fail('NETWORK_RETRYABLE', '学校登录页暂时不可用，请稍后重试');
      let target = loginTarget(page.body, s);
      if (!target) {
        const next = announcedRedirect(page.body);
        if (next && next !== page.url) {
          const moved = await s.http({url: next, purpose: 'auth', upgradeHttpRedirects: true, charset: 'UTF-8'});
          if (moved.status >= 500 || moved.status === 429) fail('NETWORK_RETRYABLE', '学校登录页暂时不可用，请稍后重试');
          page = moved;
          target = loginTarget(moved.body, s);
        }
      }
      if (!target) {
        if (!loginPage(page.body, s)) {
          const session = await existingSession(s);
          if (session) return session;
        }
        fail('PAGE_CHANGED', '登录页无法识别（' + describePage(page, s) + '）。请确认学校教务入口可正常打开后重试');
      }
      target.fields[target.accountField] = a.username.trim();
      // The school script clears the password field and submits the encoded value instead.
      target.fields[target.passwordField] = '';
      target.fields.encoded = encodeInp(a.username.trim()) + '%%%' + encodeInp(a.password);
      const p: Pending = {id: token(), kind: 'captcha', expires: Date.now() + 5 * 60_000, url: target.url, fields: target.fields, captchaField: target.captchaField};
      await s.state.set('pending', p);
      return target.captchaField ? captcha(s, p) : submit(s, p);
    },
    resume: async (a, _c, s) => {
      const p = await pending(s, a.continuationId);
      if (p.kind === 'web') {
        if (!a.webLoginCompleted) fail('WEB_LOGIN_REQUIRED', '请先完成学校官方登录页的验证');
        return validate(s);
      }
      if (!a.captcha?.trim()) return captcha(s, p);
      if (!p.captchaField) fail('SESSION_EXPIRED', '登录表单已失效，请重新登录');
      p.fields![p.captchaField] = a.captcha.trim();
      return submit(s, p);
    },
    refreshCaptcha: async (a, _c, s) => captcha(s, await pending(s, a.continuationId), true),
    validate: (_a, _c, s) => validate(s),
  },
} satisfies AcademicPlugin;
