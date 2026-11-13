import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(92)
Config.setCodec('h264')
Config.setCrf(18)
Config.setPixelFormat('yuv420p')
Config.setConcurrency(4)
// Remotion's own Chrome Headless Shell is used by default. If its download is
// slow or blocked, pass --browser-executable (see README in the report).
