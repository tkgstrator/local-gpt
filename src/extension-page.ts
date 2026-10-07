import { installPageObserver } from './page-observer'
import { installNativeChat } from './native-chat'
const native = installNativeChat(window)
installPageObserver(window, native)
