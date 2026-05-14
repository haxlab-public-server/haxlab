function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

export default class Logger {
  private log(level: string, message: string): void {
    const prefix = '[' + timestamp() + '] [' + level + ']';
    const fullMsg = prefix + ' ' + message;
    if (typeof console !== 'undefined') {
      if (level === 'ERROR') {
        console.error(fullMsg);
      } else if (level === 'WARN') {
        console.warn(fullMsg);
      } else {
        console.log(fullMsg);
      }
    }
  }

  info(msg: string): void {
    this.log('INFO', msg);
  }

  warn(msg: string): void {
    this.log('WARN', msg);
  }

  error(msg: string): void {
    this.log('ERROR', msg);
  }

  debug(msg: string): void {
    this.log('DEBUG', msg);
  }
}
