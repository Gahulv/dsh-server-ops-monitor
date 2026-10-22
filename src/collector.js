// Fixed Linux-only read commands; no browser input is interpolated.
export const COLLECT_COMMAND = String.raw`LC_ALL=C; export LC_ALL; test -r /proc/stat && test -r /proc/meminfo || exit 64
printf 'load\t'; cat /proc/loadavg
awk '/^cpu / {printf "cpu\t"; for(i=2;i<=9;i++) printf "%s ", $i; print ""}' /proc/stat
awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "memory\t%s %s\n", t,a}' /proc/meminfo
df -Pk / | awk 'NR==2 {printf "disk\t%s %s %s\n", $2,$3,$4}'
printf 'uptime\t'; cat /proc/uptime
awk -F: '/:/ {gsub(/^[ \t]+/,"",$1); if ($1 != "lo") {split($2,a," "); rx+=a[1]; tx+=a[9]}} END {printf "network\t%.0f %.0f\n", rx,tx}' /proc/net/dev`;

export function parseSnapshot(stdout) {
  const fields = Object.fromEntries(String(stdout).trim().split('\n').map(line => { const i=line.indexOf('\t'); return [line.slice(0,i), line.slice(i+1).trim().split(/\s+/).map(Number)]; }));
  for (const [key, count] of [['load',3],['cpu',8],['memory',2],['disk',3],['uptime',1],['network',2]]) {
    if (!fields[key] || fields[key].length < count || fields[key].slice(0,count).some(n => !Number.isFinite(n) || n < 0)) throw new Error('无法解析 Linux 监控数据: ' + key);
  }
  const [total, available] = fields.memory;
  if (!total || available > total || !fields.disk[0]) throw new Error('Linux 内存或磁盘数据无效');
  return {network:{rxBytes:fields.network[0],txBytes:fields.network[1]},load:fields.load.slice(0,3), cpuTicks:fields.cpu.reduce((a,b)=>a+b,0), idleTicks:fields.cpu[3]+fields.cpu[4], memory:{totalBytes:total*1024,availableBytes:available*1024,usedPercent:100*(total-available)/total},disk:{totalBytes:fields.disk[0]*1024,usedBytes:fields.disk[1]*1024,availableBytes:fields.disk[2]*1024,usedPercent:100*fields.disk[1]/fields.disk[0]},uptimeSeconds:fields.uptime[0]};
}
