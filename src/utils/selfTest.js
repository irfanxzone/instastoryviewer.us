const { resolveInstagramInput } = require('../services/inputResolver');
const samples = [
  'cristiano', '@cristiano', 'https://instagram.com/cristiano/',
  'https://www.instagram.com/stories/cristiano/123456/',
  'https://www.instagram.com/reel/ABC123/'
];
for (const sample of samples) console.log(sample, '=>', resolveInstagramInput(sample));
