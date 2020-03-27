import dep from './dep';
import getDep from './get-dep';

output = getDep.then(_async => [dep, _async]);
