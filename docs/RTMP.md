# Notes about RTMP

## Chunk Streams

Chunk Streams are completely arbitrary. They are *only* useful for determining that two or more chunks are part of the 
same message and have no meaning beyond that. You can send messages of any type on any chunk stream, but that's rarely
the most efficient way to do it. 

The only exception is the RTMP Chunk Stream protocol messages which must be sent on Chunk Stream ID 2.

Most implementations use a small number of statically defined chunk streams when they send. FFMPEG for example calls 
these "channels", and uses one channel per type of message (audio / video / control)

# Undocumented Topics

Some parts of RTMP are unspecified by Adobe. This section collects those.

## @setDataFrame

This is used for metadata.

- https://helpx.adobe.com/adobe-media-server/dev/adding-metadata-live-stream.html

## Sample Access

RTMP can express that access to raw audio/video data can be restricted. This is done with the `|RtmpSampleAccess` 
RPC command. 

- https://www.mail-archive.com/ffmpeg-devel@ffmpeg.org/msg107798.html
- https://nicolas.brousse.info/blog/flash-how-to-fix-the-security-sandbox-violation-bitmapdata-draw/
- https://sclaggett.com/A-Peek-Inside-Adobes-Real-Time-Messaging-Protocol-RTMP/
