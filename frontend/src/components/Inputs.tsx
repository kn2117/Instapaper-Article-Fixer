import { useEffect, useState } from "react";

export function AuthorsInput({
    value,
    onCommit,
}: {
    value: string;
    onCommit: (
        value: string
    ) => void;
}) {
    const [
        localValue,
        setLocalValue,
    ] = useState(value);

    useEffect(() => {
        setLocalValue(value);
    }, [value]);

    return (
        <input
            className="articleAuthorsBox"
            type="text"
            placeholder="Authors"
            value={localValue}
            onChange={(e) =>
                setLocalValue(
                    e.target.value
                )
            }
            onBlur={() =>
                onCommit(
                    localValue
                )
            }
        />
    );
}

export function TitleInput({
    value,
    onCommit,
}: {
    value: string;
    onCommit: (
        value: string
    ) => void;
}) {
    const [
        localValue,
        setLocalValue,
    ] = useState(value);

    useEffect(() => {
        setLocalValue(value);
    }, [value]);

    return (
        <input
            className="articleTitleBox"
            type="text"
            value={localValue}
            onChange={(e) =>
                setLocalValue(
                    e.target.value
                )
            }
            onBlur={() =>
                onCommit(
                    localValue
                )
            }
        />
    );
}