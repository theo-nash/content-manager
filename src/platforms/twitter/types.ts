import { UUID } from "@elizaos/core";

export type MediaData = {
    data: Buffer;
    mediaType: string;
};

const emptyUuid: UUID = "00000000-0000-0000-0000-000000000000";

export const blankState = {
    bio: "",
    lore: "",
    messageDirections: "",
    postDirections: "",
    roomId: emptyUuid,
    actors: "",
    recentMessages: "",
    recentMessagesData: [],
}