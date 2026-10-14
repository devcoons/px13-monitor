import {readingMarkup} from '../digits.js';

const padded = readingMarkup([500, 0], {pad: true, digits: 4});
if (padded !== '<span fgalpha="38%">0</span>500<span fgalpha="45%"> · </span><span fgalpha="38%">000</span>0')
    throw new Error(padded);

const plain = readingMarkup([500, 3000], {pad: false, digits: 4});
if (plain !== '500<span fgalpha="45%"> · </span>3000')
    throw new Error(plain);

const wide = readingMarkup([12000], {pad: true, digits: 4});
if (wide !== '12000')
    throw new Error(wide);

if (readingMarkup([], {pad: true, digits: 4}) !== '—')
    throw new Error('empty');

console.log('digits ok');
