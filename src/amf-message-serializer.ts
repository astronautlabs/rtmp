import { AMF0, AMF3 } from "@astronautlabs/amf";
import { BitstreamElement, BitstreamReader, BitstreamWriter, FieldDefinition, IncompleteReadResult, Serializer } from "@astronautlabs/bitstream";

export class AMFMessageSerializer implements Serializer {
    *read(reader: BitstreamReader, type: any, parent: BitstreamElement, field: FieldDefinition): Generator<IncompleteReadResult, any, unknown> {
        let amfType : typeof AMF0.Value = <typeof AMF0.Value>field?.options?.array?.type ?? AMF0.Value;
        let values : (AMF0.Value | AMF3.Value)[] = [];

        while (true) {
            let result = amfType.read(reader).next();
            if (result.done === false)
                return values;
            values.push(result.value);
        }
    }

    write(writer: BitstreamWriter, type: any, parent: BitstreamElement, field: FieldDefinition, value: AMF0.Value[]) {
        value.forEach(v => v.write(writer));
    }
}