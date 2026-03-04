import { registerRootComponent } from 'expo';

import App from './AppWrapper';
import { setupDevLogBox } from './utils/logger';

setupDevLogBox();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
registerRootComponent(App);
