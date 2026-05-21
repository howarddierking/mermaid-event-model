package com.example.hotel.shared;

/**
 * Thrown by command handlers when a slice's expected error condition fires.
 * Each {@code error["..."]} entry in a sliceTests "then" block maps to a
 * {@code throw new HotelModelException(...)} in the handler, with the test
 * message used verbatim as the exception message.
 */
public class HotelModelException extends RuntimeException {

    public HotelModelException(String message) {
        super(message);
    }
}
