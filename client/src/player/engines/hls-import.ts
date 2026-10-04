/** Own module so the jest setup can replace the dynamic import (jest runs without VM modules). */
export const importHls = () => import('hls.js');
