// TrackSource values come from the installed server SDK at the call site.
export function publisherGrant(publisher, room, sources) {
  return {roomJoin:true,room,canPublish:publisher,canSubscribe:!publisher,canPublishData:false,
    ...(publisher?{canPublishSources:[sources.CAMERA,sources.SCREEN_SHARE_AUDIO]}:{})};
}
