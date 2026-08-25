import fs from 'node:fs';
const labels = JSON.parse(fs.readFileSync(new URL('./label.json', import.meta.url), 'utf8'));
console.log(`eval: ${labels.length} samples`);
let tp=0, fp=0, fn=0, tn=0;
labels.forEach(s=>{
  // placeholder scoring: 0.92 threshold mock
  const mockScore = s.titleA.slice(0,2)===s.titleB.slice(0,2) ? 0.95 : 0.6;
  const pred = mockScore>=0.92 ? 1 : 0;
  if(pred===1 && s.label===1) tp++;
  else if(pred===1 && s.label===0) fp++;
  else if(pred===0 && s.label===1) fn++;
  else tn++;
});
const prec = tp/(tp+fp||1), rec=tp/(tp+fn||1);
console.log(`TP ${tp} FP ${fp} FN ${fn} TN ${tn} Prec ${prec.toFixed(2)} Rec ${rec.toFixed(2)}`);
