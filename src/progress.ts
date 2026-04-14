const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createProgress() {
  let frame = 0;
  let message = "";
  const isTTY = process.stderr.isTTY;

  function render() {
    if (!isTTY) return;
    frame = (frame + 1) % SPINNER.length;
    process.stderr.write(`\r\x1b[K${SPINNER[frame]} ${message}`);
  }

  return {
    update(msg: string) {
      message = msg;
      render();
    },
    stop() {
      if (isTTY) process.stderr.write("\r\x1b[K");
    },
  };
}
