// expo, expo-router, @expo/metro-runtime, @expo/router-server, @radix-ui/* 패키지의 react-dom peer 선언을 제거한다.
const STRIP_REACT_DOM = new Set(['expo', 'expo-router', '@expo/metro-runtime', '@expo/router-server']);

function readPackage(pkg) {
  if (!STRIP_REACT_DOM.has(pkg.name) && !pkg.name?.startsWith('@radix-ui/')) return pkg;
  if (pkg.peerDependencies) delete pkg.peerDependencies['react-dom'];
  if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta['react-dom'];
  return pkg;
}

module.exports = { hooks: { readPackage } };
