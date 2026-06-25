import MotionLab, { PhoneSensorClient } from './components/MotionLab';

const readHashRoute = () => {
  const hash = window.location.hash.replace(/^#/, '');
  const [path = ''] = hash.split('?');
  return path;
};

const isPhoneSensorRoute = () => {
  const hashPath = readHashRoute();

  return (
    window.location.pathname === '/motion-phone'
    || window.location.pathname.startsWith('/motion-phone/')
    || hashPath === '/motion-phone'
    || hashPath.startsWith('/motion-phone/')
  );
};

const App = () => (
  isPhoneSensorRoute() ? <PhoneSensorClient /> : <MotionLab />
);

export default App;
