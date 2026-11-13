// Общие помощники тестов: капча и регистрация.
async function solveCaptcha(base) {
  const res = await fetch(base + '/api/auth/captcha');
  const data = await res.json();
  const match = /(\d+)\s*([+\-−])\s*(\d+)/.exec(data.question || '');
  if (!match) throw new Error('Не разобрал капчу: ' + data.question);

  const a = Number(match[1]);
  const b = Number(match[3]);
  const answer = match[2] === '+' ? a + b : Math.abs(a - b);
  return { captchaId: data.id, captchaAnswer: String(answer) };
}

function extractCookie(res) {
  const header = res.headers.get('set-cookie') || '';
  const match = header.match(/pw_session=([^;]+)/);
  return match ? 'pw_session=' + match[1] : '';
}

module.exports = { solveCaptcha, extractCookie };
