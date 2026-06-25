import qrcode from 'qrcode-generator';

export const createQrPath = (text, quietZone = 4) => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const modules = Array.from({ length: moduleCount }, (_, row) => (
    Array.from({ length: moduleCount }, (_, col) => qr.isDark(row, col))
  ));
  const size = moduleCount + quietZone * 2;
  const path = [];

  modules.forEach((row, rowIndex) => {
    row.forEach((isDark, colIndex) => {
      if (isDark) {
        path.push(`M${colIndex + quietZone} ${rowIndex + quietZone}h1v1h-1z`);
      }
    });
  });

  return {
    path: path.join(''),
    size,
    modules,
  };
};
