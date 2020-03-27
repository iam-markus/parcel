import dep from './dep';
import getDep from './get-dep';

export default getDep.then(_async => [dep, _async]);
