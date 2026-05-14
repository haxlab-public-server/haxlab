import type { BotContext, ChooseTimers, PlayingTeam } from '../types';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default class AutoManager {
  private readonly CONFIG = {
    chooseTimeSec: 20,
  };

  private readonly MAPS = {
    futsal_1x1: '{"name":"Futsal 1v1 by Luchooo from HaxMaps","width":420,"height":200,"spawnDistance":180,"bg":{"type":"hockey","width":368,"height":171,"kickOffRadius":50,"cornerRadius":0},"vertexes":[{"x":-368,"y":171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":-368,"y":50,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":-368,"y":-50,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":-368,"y":-171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":368,"y":171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":368,"y":50,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":368,"y":-50,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":368,"y":-171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":0,"y":176,"trait":"kickOffBarrier"},{"x":0,"y":50,"trait":"kickOffBarrier"},{"x":0,"y":-50,"trait":"line"},{"x":0,"y":-176,"trait":"kickOffBarrier"},{"x":-384,"y":-50,"bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"x":384,"y":-50,"bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"x":-384,"y":50,"bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"x":384,"y":50,"bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"x":-368,"y":-127,"trait":"line"},{"x":368,"y":-127,"trait":"line"},{"x":-368,"y":127,"trait":"line"},{"x":368,"y":127,"trait":"line"},{"x":-350,"y":-171,"bCoef":0,"trait":"line"},{"x":-368,"y":-163,"bCoef":0,"trait":"line"},{"x":350,"y":-171,"bCoef":0,"trait":"line"},{"x":368,"y":-163,"bCoef":0,"trait":"line"},{"x":-350,"y":171,"bCoef":0,"trait":"line"},{"x":-368,"y":163,"bCoef":0,"trait":"line"},{"x":350,"y":171,"bCoef":0,"trait":"line"},{"x":368,"y":163,"bCoef":0,"trait":"line"},{"x":368,"y":171,"bCoef":1,"trait":"ballArea"},{"x":368,"y":-171,"bCoef":1,"trait":"ballArea"},{"x":0,"y":171,"bCoef":0,"trait":"line"},{"x":0,"y":-171,"bCoef":0,"trait":"line"},{"x":0,"y":50,"trait":"kickOffBarrier"},{"x":0,"y":-50,"trait":"kickOffBarrier"},{"x":377,"y":-50,"bCoef":1,"cMask":["red"],"trait":"line"},{"x":377,"y":-171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":-377,"y":-50,"bCoef":1,"cMask":["blue"],"trait":"line"},{"x":-377,"y":-171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":-377,"y":50,"bCoef":1,"cMask":["blue"],"trait":"line"},{"x":-377,"y":171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"},{"x":377,"y":50,"bCoef":1,"cMask":["red"],"trait":"line"},{"x":377,"y":171,"bCoef":1,"cMask":["ball"],"trait":"ballArea"}],"segments":[{"v0":0,"v1":1,"trait":"ballArea"},{"v0":2,"v1":3,"trait":"ballArea"},{"v0":4,"v1":5,"trait":"ballArea"},{"v0":6,"v1":7,"trait":"ballArea"},{"v0":8,"v1":9,"trait":"kickOffBarrier"},{"v0":9,"v1":10,"curve":180,"cGroup":["blueKO"],"trait":"kickOffBarrier"},{"v0":9,"v1":10,"curve":-180,"cGroup":["redKO"],"trait":"kickOffBarrier"},{"v0":10,"v1":11,"trait":"kickOffBarrier"},{"v0":2,"v1":12,"curve":-35,"vis":true,"color":"FFFFFF","bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"v0":6,"v1":13,"curve":35,"vis":true,"color":"FFFFFF","bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"v0":1,"v1":14,"curve":35,"vis":true,"color":"FFFFFF","bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"v0":5,"v1":15,"curve":-35,"vis":true,"color":"FFFFFF","bCoef":0.1,"cMask":["all"],"trait":"goalNet"},{"v0":12,"v1":14,"curve":-35,"vis":true,"color":"FFFFFF","bCoef":0.1,"cMask":["all"],"trait":"goalNet","x":-585},{"v0":13,"v1":15,"curve":35,"vis":true,"color":"FFFFFF","bCoef":0.1,"cMask":["all"],"trait":"goalNet","x":585},{"v0":1,"v1":0,"vis":true,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":-368},{"v0":5,"v1":4,"vis":true,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":368},{"v0":2,"v1":3,"vis":true,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":-368},{"v0":6,"v1":7,"vis":true,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":368},{"v0":0,"v1":28,"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","y":171},{"v0":3,"v1":29,"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","y":-171},{"v0":30,"v1":31,"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line"},{"v0":10,"v1":9,"curve":-180,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line"},{"v0":33,"v1":32,"curve":180,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line"},{"v0":2,"v1":1,"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line"},{"v0":6,"v1":5,"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line"},{"v0":34,"v1":35,"vis":false,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":330},{"v0":36,"v1":37,"vis":false,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":-330},{"v0":38,"v1":39,"vis":false,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":-330},{"v0":40,"v1":41,"vis":false,"color":"FFFFFF","bCoef":1,"cMask":["ball"],"trait":"ballArea","x":330},{"v0":34,"v1":40,"curve":60,"vis":false,"color":"FFFFFF","bCoef":1,"cMask":["red"],"trait":"line"},{"v0":38,"v1":36,"curve":60,"vis":false,"color":"FFFFFF","bCoef":1,"cMask":["blue"],"trait":"line"}],"goals":[{"p0":[-372,-52],"p1":[-372,48],"team":"red"},{"p0":[372,50],"p1":[372,-50],"team":"blue"}],"discs":[{"radius":5,"pos":[-368,50],"color":"FFFFFF","trait":"goalPost"},{"radius":5,"pos":[-368,-50],"color":"FFFFFF","trait":"goalPost"},{"radius":5,"pos":[368,50],"color":"FFFFFF","trait":"goalPost"},{"radius":5,"pos":[368,-50],"color":"FFFFFF","trait":"goalPost"},{"radius":3,"invMass":0,"pos":[383,51],"color":"FFFFFF","bCoef":0,"trait":"line"},{"radius":3,"invMass":0,"pos":[-383,51],"color":"FFFFFF","bCoef":0,"trait":"line"},{"radius":3,"invMass":0,"pos":[383,-51],"color":"FFFFFF","bCoef":0,"trait":"line"},{"radius":3,"invMass":0,"pos":[-383,-51],"color":"FFFFFF","bCoef":0,"trait":"line"}],"planes":[{"normal":[0,1],"dist":-171,"trait":"ballArea"},{"normal":[0,-1],"dist":-171,"trait":"ballArea"},{"normal":[0,1],"dist":-200,"bCoef":0.2,"cMask":["all"]},{"normal":[0,-1],"dist":-200,"bCoef":0.2,"cMask":["all"]},{"normal":[1,0],"dist":-420,"bCoef":0.2,"cMask":["all"]},{"normal":[-1,0],"dist":-420,"bCoef":0.2,"cMask":["all"]}],"traits":{"ballArea":{"vis":false,"bCoef":1,"cMask":["ball"]},"goalPost":{"radius":8,"invMass":0,"bCoef":1},"goalNet":{"vis":true,"bCoef":0.1,"cMask":["all"]},"kickOffBarrier":{"vis":false,"bCoef":0.1,"cGroup":["redKO","blueKO"],"cMask":["red","blue"]},"line":{"vis":true,"bCoef":0,"cMask":[""]},"arco":{"radius":2,"cMask":["n\\/d"],"color":"cccccc"}},"playerPhysics":{"acceleration":0.11,"kickingAcceleration":0.1,"kickStrength":6.5},"ballPhysics":{"radius":6.4,"color":"EAFF00"}}',
    futsal_2x2: '{"name":"Futsal 1x1 2x2 from HaxMaps","width":420,"height":200,"spawnDistance":180,"bg":{"type":"hockey","width":368,"height":171,"kickOffRadius":65,"cornerRadius":0},"vertexes":[{"x":-368,"y":171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-368,"y":65,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-368,"y":-65,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-368,"y":-171,"trait":"ballArea","bCoef":1,"cMask":["ball"]},{"x":368,"y":171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":368,"y":65,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":368,"y":-65,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":368,"y":-171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":0,"y":65,"trait":"kickOffBarrier"},{"x":0,"y":-65,"trait":"line"},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":-384,"y":-65},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":384,"y":-65},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":-384,"y":65},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":384,"y":65},{"bCoef":1,"trait":"ballArea","x":368,"y":171},{"bCoef":1,"trait":"ballArea","x":368,"y":-171},{"bCoef":0,"trait":"line","x":0,"y":171},{"bCoef":0,"trait":"line","x":0,"y":-171},{"x":0,"y":65,"trait":"kickOffBarrier"},{"x":0,"y":-65,"trait":"kickOffBarrier"},{"x":377,"y":-65,"trait":"line","cMask":["ball"],"bCoef":1},{"x":377,"y":-171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-377,"y":-65,"trait":"line","cMask":["ball"],"bCoef":1},{"x":-377,"y":-171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-377,"y":65,"trait":"line","cMask":["ball"],"bCoef":1},{"x":-377,"y":171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":377,"y":65,"trait":"line","cMask":["ball"],"bCoef":1},{"x":377,"y":171,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":0,"y":199,"trait":"kickOffBarrier"},{"x":0,"y":65,"trait":"kickOffBarrier"},{"x":0,"y":-65,"trait":"kickOffBarrier"},{"x":0,"y":-199,"trait":"kickOffBarrier"}],"segments":[{"v0":0,"v1":1,"trait":"ballArea"},{"v0":2,"v1":3,"trait":"ballArea"},{"v0":4,"v1":5,"trait":"ballArea"},{"v0":6,"v1":7,"trait":"ballArea"},{"v0":8,"v1":9,"trait":"kickOffBarrier","curve":180,"cGroup":["blueKO"]},{"v0":8,"v1":9,"trait":"kickOffBarrier","curve":-180,"cGroup":["redKO"]},{"vis":true,"bCoef":0.1,"cMask":["all"],"trait":"goalNet","v0":2,"v1":10,"color":"FFFFFF","curve":-35},{"vis":true,"bCoef":0.1,"cMask":["all"],"trait":"goalNet","v0":6,"v1":11,"color":"FFFFFF","curve":35},{"vis":true,"bCoef":0.1,"cMask":["all"],"trait":"goalNet","v0":1,"v1":12,"color":"FFFFFF","curve":35},{"vis":true,"bCoef":0.1,"cMask":["all"],"trait":"goalNet","v0":5,"v1":13,"color":"FFFFFF","curve":-35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":10,"v1":12,"x":-585,"color":"FFFFFF","curve":-35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":11,"v1":13,"x":585,"color":"FFFFFF","curve":35},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":1,"v1":0,"cMask":["ball"],"x":-368},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":5,"v1":4,"cMask":["ball"],"x":368},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":2,"v1":3,"cMask":["ball"],"x":-368},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":6,"v1":7,"cMask":["ball"],"x":368},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":0,"v1":14,"y":171},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":3,"v1":15,"y":-171},{"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":16,"v1":17},{"curve":-180,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":9,"v1":8},{"curve":180,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":19,"v1":18},{"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":2,"v1":1},{"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":6,"v1":5},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":20,"v1":21,"cMask":["ball"],"x":330},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":22,"v1":23,"cMask":["ball"],"x":-330},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":24,"v1":25,"cMask":["ball"],"x":-330},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":26,"v1":27,"cMask":["ball"],"x":330},{"v0":28,"v1":29,"trait":"kickOffBarrier"},{"v0":30,"v1":31,"trait":"kickOffBarrier"}],"goals":[{"p0":[-377,-65],"p1":[-377,65],"team":"red"},{"p0":[377,65],"p1":[377,-65],"team":"blue"}],"discs":[{"pos":[-368,65],"trait":"goalPost","color":"FFFFFF","radius":5},{"pos":[-368,-65],"trait":"goalPost","color":"FFFFFF","radius":5},{"pos":[368,65],"trait":"goalPost","color":"FFFFFF","radius":5},{"pos":[368,-65],"trait":"goalPost","color":"FFFFFF","radius":5}],"planes":[{"normal":[0,1],"dist":-171,"trait":"ballArea"},{"normal":[0,-1],"dist":-171,"trait":"ballArea"},{"normal":[0,1],"dist":-200,"bCoef":0.2,"cMask":["all"]},{"normal":[0,-1],"dist":-200,"bCoef":0.2,"cMask":["all"]},{"normal":[1,0],"dist":-420,"bCoef":0.2,"cMask":["all"]},{"normal":[-1,0],"dist":-420,"bCoef":0.2,"cMask":["all"]}],"traits":{"ballArea":{"vis":false,"bCoef":1,"cMask":["ball"]},"goalPost":{"radius":8,"invMass":0,"bCoef":1},"goalNet":{"vis":true,"bCoef":0.1,"cMask":["all"]},"kickOffBarrier":{"vis":false,"bCoef":0.1,"cGroup":["redKO","blueKO"],"cMask":["red","blue"]},"line":{"vis":true,"bCoef":0,"cMask":[""]},"arco":{"radius":2,"cMask":["n\\/d"],"color":"cccccc"}},"playerPhysics":{"acceleration":0.11,"kickingAcceleration":0.1,"kickStrength":7},"ballPhysics":{"radius":6.4,"color":"EAFF00"}}',
    futsal_4x4: '{"name":"Futsal 3x3 4x4 from HaxMaps","width":755,"height":339,"spawnDistance":310,"bg":{"type":"hockey","width":665,"height":290,"kickOffRadius":80,"cornerRadius":0},"vertexes":[{"x":-665,"y":290,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-665,"y":80,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-665,"y":-80,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-665,"y":-290,"trait":"ballArea","bCoef":1,"cMask":["ball"]},{"x":665,"y":290,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":665,"y":80,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":665,"y":-80,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":665,"y":-290,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":0,"y":306,"trait":"kickOffBarrier"},{"x":0,"y":80,"trait":"kickOffBarrier"},{"x":0,"y":-80,"trait":"line"},{"x":0,"y":-306,"trait":"kickOffBarrier"},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":-693,"y":-80},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":693,"y":-80},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":-693,"y":80},{"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","x":693,"y":80},{"trait":"line","x":-665,"y":-215},{"trait":"line","x":-500,"y":-50},{"trait":"line","x":665,"y":-215},{"trait":"line","x":500,"y":-50},{"trait":"line","x":-665,"y":215},{"trait":"line","x":-500,"y":50},{"trait":"line","x":665,"y":215},{"trait":"line","x":500,"y":50},{"bCoef":1,"trait":"ballArea","x":665,"y":290},{"bCoef":1,"trait":"ballArea","x":665,"y":-290},{"bCoef":0,"trait":"line","x":0,"y":290},{"bCoef":0,"trait":"line","x":0,"y":-290},{"x":0,"y":80,"trait":"kickOffBarrier"},{"x":0,"y":-80,"trait":"kickOffBarrier"},{"x":674,"y":-80,"trait":"line","cMask":["ball"],"bCoef":1},{"x":674,"y":-290,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-674,"y":-80,"trait":"line","cMask":["ball"],"bCoef":1},{"x":-674,"y":-290,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":-674,"y":80,"trait":"line","cMask":["ball"],"bCoef":1},{"x":-674,"y":290,"trait":"ballArea","cMask":["ball"],"bCoef":1},{"x":674,"y":80,"trait":"line","cMask":["ball"],"bCoef":1},{"x":674,"y":290,"trait":"ballArea","cMask":["ball"],"bCoef":1}],"segments":[{"v0":0,"v1":1,"trait":"ballArea"},{"v0":2,"v1":3,"trait":"ballArea"},{"v0":4,"v1":5,"trait":"ballArea"},{"v0":6,"v1":7,"trait":"ballArea"},{"v0":8,"v1":9,"trait":"kickOffBarrier"},{"v0":9,"v1":10,"trait":"kickOffBarrier","curve":180,"cGroup":["blueKO"]},{"v0":9,"v1":10,"trait":"kickOffBarrier","curve":-180,"cGroup":["redKO"]},{"v0":10,"v1":11,"trait":"kickOffBarrier"},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":2,"v1":12,"color":"FFFFFF","curve":-35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":6,"v1":13,"color":"FFFFFF","curve":35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":1,"v1":14,"color":"FFFFFF","curve":35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":5,"v1":15,"color":"FFFFFF","curve":-35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":12,"v1":14,"x":-585,"color":"FFFFFF","curve":-35},{"vis":true,"bCoef":0.1,"cMask":["ball"],"trait":"goalNet","v0":13,"v1":15,"x":585,"color":"FFFFFF","curve":35},{"color":"FFFFFF","trait":"line","v0":16,"v1":17,"curve":90},{"color":"FFFFFF","trait":"line","v0":18,"v1":19,"curve":-90},{"color":"FFFFFF","trait":"line","v0":20,"v1":21,"curve":-90},{"color":"FFFFFF","trait":"line","v0":22,"v1":23,"curve":90},{"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":17,"v1":21,"curve":0},{"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":19,"v1":23,"curve":0},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":1,"v1":0,"cMask":["ball"],"x":-665},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":5,"v1":4,"cMask":["ball"],"x":665},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":2,"v1":3,"cMask":["ball"],"x":-665},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":6,"v1":7,"cMask":["ball"],"x":665},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":0,"v1":24,"y":290},{"vis":true,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":3,"v1":25,"y":-290},{"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":26,"v1":27},{"curve":-180,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":10,"v1":9},{"curve":180,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":29,"v1":28},{"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":2,"v1":1},{"curve":0,"vis":true,"color":"FFFFFF","bCoef":0,"trait":"line","v0":6,"v1":5},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":30,"v1":31,"cMask":["ball"],"x":614},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":32,"v1":33,"cMask":["ball"],"x":-614},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":34,"v1":35,"cMask":["ball"],"x":-614},{"vis":false,"color":"FFFFFF","bCoef":1,"trait":"ballArea","v0":36,"v1":37,"cMask":["ball"],"x":614}],"goals":[{"p0":[-674,-80],"p1":[-674,80],"team":"red"},{"p0":[674,80],"p1":[674,-80],"team":"blue"}],"discs":[{"pos":[-665,80],"trait":"goalPost","color":"FFFFFF","radius":5},{"pos":[-665,-80],"trait":"goalPost","color":"FFFFFF","radius":5},{"pos":[665,80],"trait":"goalPost","color":"FFFFFF","radius":5},{"pos":[665,-80],"trait":"goalPost","color":"FFFFFF","radius":5}],"planes":[{"normal":[0,1],"dist":-290,"trait":"ballArea"},{"normal":[0,-1],"dist":-290,"trait":"ballArea"},{"normal":[0,1],"dist":-339,"bCoef":0.2,"cMask":["all"]},{"normal":[0,-1],"dist":-339,"bCoef":0.2,"cMask":["all"]},{"normal":[1,0],"dist":-755,"bCoef":0.2,"cMask":["all"]},{"normal":[-1,0],"dist":-755,"bCoef":0.2,"cMask":["all"]}],"traits":{"ballArea":{"vis":false,"bCoef":1,"cMask":["ball"]},"goalPost":{"radius":8,"invMass":0,"bCoef":1},"goalNet":{"vis":true,"bCoef":0.1,"cMask":["all"]},"kickOffBarrier":{"vis":false,"bCoef":0.1,"cGroup":["redKO","blueKO"],"cMask":["red","blue"]},"line":{"vis":true,"bCoef":0,"cMask":[""]},"arco":{"radius":2,"cMask":["n\\/d"],"color":"cccccc"}},"playerPhysics":{"acceleration":0.11,"kickingAcceleration":0.1,"kickStrength":7},"ballPhysics":{"radius":6.4,"color":"EAFF00"}}'
  };

  setStadiumForPlayers(ctx: BotContext, totalPlayers: number) {
    try {
      if (totalPlayers <= 2) {
        ctx.room.setCustomStadium(this.MAPS.futsal_1x1);
      } else if (totalPlayers <= 4) {
        ctx.room.setCustomStadium(this.MAPS.futsal_2x2);
      } else {
        ctx.room.setCustomStadium(this.MAPS.futsal_4x4);
      }
    } catch (e) {
      ctx.logger.warn('setStadium failed: ' + errMsg(e));
    }
  }

  private getTeamsSnapshot(ctx: BotContext) {
    const list = ctx.room.getPlayerList();
    const teams: { red: PlayerObject[]; blue: PlayerObject[]; spec: PlayerObject[] } = { red: [], blue: [], spec: [] };
    for (const p of list) {
      if (p.team === 1) teams.red.push(p);
      else if (p.team === 2) teams.blue.push(p);
      else teams.spec.push(p);
    }
    return teams;
  }

  private instantRestart(ctx: BotContext) {
    try { ctx.room.stopGame(); } catch {}
    setTimeout(() => { try { ctx.room.startGame(); } catch {} }, 10);
  }

  balanceTeams(ctx: BotContext) {
    const list = ctx.room.getPlayerList();
    const totalPlayers = list.length;
    this.setStadiumForPlayers(ctx, totalPlayers);

    const teams = this.getTeamsSnapshot(ctx);

    if (totalPlayers === 0) {
      try { ctx.room.stopGame(); } catch {}
      ctx.room.setScoreLimit(1);
      ctx.room.setTimeLimit(0);
      return;
    }

    if (totalPlayers === 1 && teams.red.length === 0) {
      this.instantRestart(ctx);
      try { ctx.room.setPlayerTeam(list[0].id, 1); } catch {}
      return;
    }

    const red = teams.red.length;
    const blue = teams.blue.length;
    const spec = teams.spec.length;

    const diff = Math.abs(red - blue);

    if (diff === spec && spec > 0) {
      const smaller = red < blue ? 1 : 2;
      const toMove = teams.spec.slice(0, diff);
      for (const s of toMove) {
        ctx.room.setPlayerTeam(s.id, smaller);
      }
      return;
    }

    if (diff > spec) {
      const largerTeam = red > blue ? teams.red : teams.blue;
      const n = diff - spec;
      for (let i = 0; i < n && i < largerTeam.length; i++) {
        ctx.room.setPlayerTeam(largerTeam[largerTeam.length - 1 - i].id, 0);
      }
      return;
    }

    const nextSize = ctx.gameState.calcNextSize(totalPlayers);
    if (red === blue && spec >= 2 && red < nextSize) {
      ctx.room.setPlayerTeam(teams.spec[0].id, 1);
      ctx.room.setPlayerTeam(teams.spec[1].id, 2);
      return;
    }

    if (diff > 0 && spec > 0) {
      this.startChooseMode(ctx);
    }
  }

  private startChooseMode(ctx: BotContext) {
    if (ctx.gameState.isChooseMode()) return;
    ctx.gameState.setChooseMode(true);
    try { ctx.room.pauseGame(true); } catch {}

    const teams = this.getTeamsSnapshot(ctx);
    // Captain is first player from smaller team
    let captain = null;
    if (teams.red.length <= teams.blue.length && teams.red.length > 0) captain = teams.red[0];
    else if (teams.blue.length < teams.red.length && teams.blue.length > 0) captain = teams.blue[0];

    if (captain) {
      ctx.room.sendAnnouncement(
        "Капитан " + captain.name + ": выбери игрока из спектаторов — номер, 'top', 'random' или 'bottom'",
        captain.id,
        0x00AAFF,
        'bold',
        2
      );
      this.showSpecList(ctx, captain);
      this.scheduleChooseTimeouts(ctx, captain);
    }
  }

  private showSpecList(ctx: BotContext, targetPlayer: PlayerObject) {
    const teams = this.getTeamsSnapshot(ctx);
    const spec = teams.spec;
    if (spec.length === 0) return;
    let msg = 'Players: ';
    for (let i = 0; i < spec.length; i++) { msg += spec[i].name + '[' + (i+1) + '], '; }
    msg = msg.slice(0, -2) + '.';
    ctx.room.sendAnnouncement(msg, targetPlayer.id, 0xFFFFFF, 'bold', 2);
  }

  private scheduleChooseTimeouts(ctx: BotContext, captain: PlayerObject) {
    if (!ctx.chooseTimers) ctx.chooseTimers = {} as ChooseTimers;
    this.clearChooseTimers(ctx);

    ctx.chooseTimers.warn = setTimeout(() => {
      ctx.room.sendAnnouncement(
        `Поторопись ${captain.name}, осталось ${Math.floor(this.CONFIG.chooseTimeSec/2)} секунд!`,
        captain.id,
        0xFFCC00,
        'bold',
        2
      );
    }, this.CONFIG.chooseTimeSec * 1000);

    ctx.chooseTimers.final = setTimeout(() => {
      this.autoTopPick(ctx, captain);
    }, this.CONFIG.chooseTimeSec * 1500);
  }

  private clearChooseTimers(ctx: BotContext) {
    if (ctx.chooseTimers) {
      try { clearTimeout(ctx.chooseTimers.warn); } catch {}
      try { clearTimeout(ctx.chooseTimers.final); } catch {}
      ctx.chooseTimers = null;
    }
  }

  private autoTopPick(ctx: BotContext, captain: PlayerObject) {
    const teams = this.getTeamsSnapshot(ctx);
    const spec = teams.spec;
    if (spec.length > 0) {
      const targetTeam = (teams.red.length <= teams.blue.length) ? 1 : 2;
      ctx.room.setPlayerTeam(spec[0].id, targetTeam);
      ctx.room.sendAnnouncement(`${captain.name} (автовыбор): Top`);
      this.postPickProgress(ctx);
    } else {
      ctx.gameState.setChooseMode(false);
      try { ctx.room.pauseGame(false); } catch {}
    }
  }

  private postPickProgress(ctx: BotContext) {
    const teams = this.getTeamsSnapshot(ctx);
    const diff = Math.abs(teams.red.length - teams.blue.length);
    if (diff === 0) {
      ctx.gameState.setChooseMode(false);
      this.clearChooseTimers(ctx);
      try { ctx.room.pauseGame(false); } catch {}
      this.scheduleAutostartIfReady(ctx);
    } else {
      const nextCaptain = (teams.red.length <= teams.blue.length && teams.red.length > 0) ? teams.red[0] : teams.blue[0];
      if (nextCaptain) {
        ctx.room.sendAnnouncement(
          "Капитан " + nextCaptain.name + ": выбери игрока — номер, 'top', 'random' или 'bottom'",
          nextCaptain.id,
          0x00AAFF,
          'bold',
          2
        );
        this.showSpecList(ctx, nextCaptain);
        this.scheduleChooseTimeouts(ctx, nextCaptain);
      }
    }
  }

  handleChooseModeMessage(ctx: BotContext, player: PlayerObject, message: string) {
    if (!ctx.gameState.isChooseMode()) return false;
    const m = (message||'').trim().toLowerCase();
    const teams = this.getTeamsSnapshot(ctx);
    const isRedCaptain = teams.red.length > 0 && player.id === teams.red[0].id && teams.red.length <= teams.blue.length;
    const isBlueCaptain = teams.blue.length > 0 && player.id === teams.blue[0].id && teams.blue.length < teams.red.length;
    if (!isRedCaptain && !isBlueCaptain) return false;

    const spec = teams.spec;
    if (spec.length === 0) return false;

    const targetTeam: PlayingTeam = isRedCaptain ? 1 : 2;
    let pickedIndex: number | null = null;

    if (m === 'top' || m === 'auto') {
      pickedIndex = 0;
    } else if (m === 'random' || m === 'rand') {
      pickedIndex = Math.floor(Math.random() * spec.length);
    } else if (m === 'bottom' || m === 'bot') {
      pickedIndex = spec.length - 1;
    } else {
      const num = parseInt(m, 10);
      if (!isNaN(num) && num >= 1 && num <= spec.length) {
        pickedIndex = num - 1;
      } else {
        return false;
      }
    }

    if (pickedIndex === null) return false;

    ctx.room.setPlayerTeam(spec[pickedIndex].id, targetTeam);
    this.clearChooseTimers(ctx);
    ctx.room.sendAnnouncement(`${player.name} выбрал ${spec[pickedIndex].name}`);
    this.postPickProgress(ctx);
    return true; // consumed
  }

  private scheduleAutostartIfReady(ctx: BotContext) {
    const list = ctx.room.getPlayerList();
    const total = list.length;
    const size = ctx.gameState.calcNextSize(total);
    const teams = this.getTeamsSnapshot(ctx);
    if (teams.red.length === size && teams.blue.length === size) {
      setTimeout(() => {
        try { ctx.room.startGame(); } catch (e) { ctx.room.sendAnnouncement('Ошибка старта: ' + errMsg(e)); }
      }, 2000);
    }
  }

  applyWinstayAndStart(ctx: BotContext, winnerOverride?: PlayingTeam | null) {
    const list = ctx.room.getPlayerList();
    const total = list.length;
    const nextSize = ctx.gameState.calcNextSize(total);
    this.setStadiumForPlayers(ctx, total);

    const teams = this.getTeamsSnapshot(ctx);
    const winner = (winnerOverride !== undefined && winnerOverride !== null) ? winnerOverride : ctx.gameState.getState().winnerTeam; // 1 or 2

    for (const p of list) {
      try { ctx.room.setPlayerTeam(p.id, 0); } catch {}
    }

    let team1Count = 0, team2Count = 0;

    const keep = winner === 1 ? teams.red : (winner === 2 ? teams.blue : []);
    for (let i = 0; i < Math.min(keep.length, nextSize); i++) {
      const pid = keep[i].id;
      ctx.room.setPlayerTeam(pid, winner);
      if (winner === 1) team1Count++; else team2Count++;
    }

    const rest = list.filter(p => !keep.some(k => k.id === p.id));
    for (const p of rest) {
      if (team1Count < nextSize) { ctx.room.setPlayerTeam(p.id, 1); team1Count++; }
      else if (team2Count < nextSize) { ctx.room.setPlayerTeam(p.id, 2); team2Count++; }
      if (team1Count === nextSize && team2Count === nextSize) break;
    }

    setTimeout(() => { try { ctx.room.startGame(); } catch {} }, 2000);
  }

}
