// ONE PLACE to change the developer credit that shows at the bottom of the shop pages.
// Change the name and the link below. Leave url as '' (empty) until your website is ready:
// then the credit shows as plain text, without a link.
const DEVELOPER = {
  name: 'ODUNSI HASSAN',
  url: 'https://api.whatsapp.com/send/?phone=2348083666792&text=Hi%2C+I+saw+your+portfolio+and+I+need+a+high-converting+website+for+my+business.&type=phone_number&app_absent=0'
};

document.addEventListener('DOMContentLoaded', () => {
  const box = document.createElement('div');
  box.style.cssText = 'text-align:center;font-size:13px;opacity:.85;margin-top:14px;padding:6px 0';
  box.append('Website by ');
  if (DEVELOPER.url) {
    const a = document.createElement('a');
    a.href = DEVELOPER.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = DEVELOPER.name; a.style.cssText = 'color:inherit;font-weight:700;text-decoration:underline';
    box.appendChild(a);
  } else {
    const b = document.createElement('b'); b.textContent = DEVELOPER.name; box.appendChild(b);
  }
  (document.querySelector('footer') || document.body).appendChild(box);
});