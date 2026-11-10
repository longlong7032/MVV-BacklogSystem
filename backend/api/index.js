// Điểm vào cho Vercel: mọi request được rewrite (vercel.json) về đây và do Express xử lý.
// Đây là file JS mỏng duy nhất còn lại; toàn bộ logic nằm trong server.ts và được `npm run build` biên dịch ra dist/.
export { default } from '../dist/server.js';
